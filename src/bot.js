'use strict'
require('./config') // Запускає валідацію env змінних одразу при старті

const TelegramBot = require('node-telegram-bot-api')
const http = require('http')
const path = require('path')
const config = require('./config')
const db = require('./db')
const { runInterviewStep, runValidator, runMermaidGenerator } = require('./agents')
const { renderMermaid } = require('./mermaidRender')

// ─── Константи ──────────────────────────────────────────────────────────────

const START_MESSAGE = `Привіт! Зараз ми побудуємо схему вашого бізнес-процесу — від того як клієнт дізнається про вас до моменту коли ви виконали замовлення і отримали оплату.

Я буду задавати питання по одному. Відповідайте як вам зручно — коротко або детально, я підлаштуюся.

Також можна відповідати:
- голосовими повідомленнями (Telegram voice)
- документами: PDF, DOC, DOCX, TXT (на цьому етапі враховую назву файлу; ключові деталі краще дублювати текстом)

Почнемо? Розкажіть коротко — чим займається ваша компанія?`

const COMPLETION_MESSAGE = `Відмінно! Ось схема бізнес-процесу вашої компанії 👆

Зверніть увагу на ролі в лівій колонці — ми будемо використовувати цю схему на всіх наступних уроках.

На наступному кроці ми додамо в цю схему всі фінансові дії — де саме в процесі виникають гроші. Переходьте до уроку 1.4 ✅`

const PROFILE_PHOTO_PATH = path.join(__dirname, '..', 'profile.jpg')
const PORT = Number(process.env.PORT || 3000)

// ─── Telegram бот ────────────────────────────────────────────────────────────

const bot = new TelegramBot(config.telegram.token, { polling: true })

// ─── Головний обробник повідомлень ───────────────────────────────────────────

async function handleMessage(userId, text) {
  let session
  try {
    session = await db.getOrCreateSession(userId)
  } catch (err) {
    console.error('[bot] DB getOrCreateSession error:', db.formatDbError(err))
    await safeSendMessage(userId, 'Виникла технічна помилка бази даних. Спробуйте /start ще раз.')
    return
  }

  if (session.status === 'complete') {
    await safeSendMessage(userId, 'Ваш процес вже побудований 🎉\n\nНадішліть /restart щоб почати заново.')
    return
  }

  // Додаємо повідомлення користувача в історію
  session.history.push({ role: 'user', content: text })

  // ── Крок 1: виклик інтерв'ю-агента ──
  let agentResponse
  try {
    agentResponse = await runInterviewStep(session)
  } catch (err) {
    console.error('[bot] Interview agent error:', err.message)
    session.history.pop() // відкочуємо невдале повідомлення
    await db.saveSession(session)
    await safeSendMessage(userId, 'Не вдалося отримати відповідь від ШІ. Будь ласка, спробуйте ще раз.')
    return
  }

  // Оновлюємо JSON-модель якщо агент повернув її
  if (agentResponse.updatedModel) {
    session.process_model = agentResponse.updatedModel
  }

  // ── Якщо інтерв'ю ще не завершено — звичайна відповідь ──
  if (!agentResponse.isComplete) {
    const botText = agentResponse.text
    if (botText) {
      session.history.push({ role: 'assistant', content: botText })
    }
    try {
      await db.saveSession(session)
    } catch (err) {
      console.error('[bot] DB saveSession error:', err.message)
    }
    if (botText) {
      await safeSendMessage(userId, botText)
    }
    return
  }

  // ── Крок 2: валідація після завершення інтерв'ю ──
  console.log(`[bot] User ${userId}: Interview complete, starting validation...`)
  if (session.validation_attempts < MAX_VALIDATION_ATTEMPTS) {
    let validationResult
    try {
      validationResult = await runValidator(session.process_model)
      console.log(`[bot] User ${userId}: Validator OK, valid=${validationResult?.valid}`)
    } catch (err) {
      console.error(`[bot] User ${userId}: Validator ERROR:`, err.message)
      validationResult = { valid: true, errors: [] }
    }

    if (!validationResult.valid && validationResult.errors && validationResult.errors.length > 0) {
      session.validation_attempts += 1
      const errorEntry = validationResult.errors[0]
      const question = errorEntry.question_to_ask

      if (question) {
        const replyText = `Майже готово! Я помітив що ми ще не описали один важливий момент.\n\n${question}`
        session.history.push({ role: 'assistant', content: replyText })
        try {
          await db.saveSession(session)
        } catch (err) {
          console.error('[bot] DB saveSession error:', err.message)
        }
        await safeSendMessage(userId, replyText)
        return
      }
    }
  }

  // ── Крок 3: генерація Mermaid та рендер PNG ──
  console.log(`[bot] User ${userId}: Starting Mermaid generation...`)
  await safeSendMessage(userId, '⏳ Будую схему вашого бізнес-процесу...')

  let mermaidCode
  try {
    console.log(`[bot] User ${userId}: Calling runMermaidGenerator...`)
    mermaidCode = await runMermaidGenerator(session.process_model)
    console.log(`[bot] User ${userId}: Mermaid OK, code length=${mermaidCode?.length}`)
    session.process_model.mermaid_code = mermaidCode
    session.mermaid_code = mermaidCode
  } catch (err) {
    console.error(`[bot] User ${userId}: Mermaid generator ERROR:`, err.message)
    session.status = 'complete'
    session.process_model.status = 'complete'
    try {
      await db.saveSession(session)
    } catch (saveErr) {
      console.error('[bot] Save after Mermaid error failed:', saveErr.message)
    }
    await safeSendMessage(userId, COMPLETION_MESSAGE)
    await safeSendMessage(userId, '❌ Помилка генерації схеми')
    return
  }

  let pngBuffer
  try {
    console.log(`[bot] User ${userId}: Calling renderMermaid...`)
    pngBuffer = await renderMermaid(mermaidCode)
    console.log(`[bot] User ${userId}: PNG render OK, size=${pngBuffer?.length} bytes`)
  } catch (err) {
    console.error(`[bot] User ${userId}: Render ERROR:`, err.message)
    session.status = 'complete'
    session.process_model.status = 'complete'
    try {
      await db.saveSession(session)
    } catch (saveErr) {
      console.error('[bot] Save after render error failed:', saveErr.message)
    }
    await safeSendMessage(userId, COMPLETION_MESSAGE)
    await safeSendMessage(userId, '📊 Схема (текстовим кодом)...')
    return
  }

  // ── Успіх: зберігаємо і відправляємо ──
  console.log(`[bot] User ${userId}: Sending completion...`)
  session.status = 'complete'
  session.process_model.status = 'complete'
  try {
    await db.saveSession(session)
  } catch (err) {
    console.error('[bot] DB saveSession error:', err.message)
  }

  // Отправляємо фото і inline-кнопки
  try {
    console.log(`[bot] User ${userId}: Sending photo with action buttons...`)
    await bot.sendPhoto(userId, pngBuffer, {
      caption: '📋 Схема бізнес-процесу вашої компанії',
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            { text: '➡️ Повернутись і редагувати', callback_data: 'action_restart' },
            { text: '📑 Завантажити', callback_data: 'action_download' }
          ]
        ]
      })
    })
  } catch (err) {
    console.error('[bot] sendPhoto error:', err.message)
    await safeSendMessage(userId, '📊 Схема отримана')
  }
  await safeSendMessage(userId, COMPLETION_MESSAGE)
  console.log(`[bot] User ${userId}: ==================== INTERVIEW FULLY COMPLETE ====================`)
}

// ─── Команди ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const userId = msg.chat.id
  try {
    await db.deleteSession(userId)
  } catch (err) {
    console.error('[bot] deleteSession error:', db.formatDbError(err))
  }

  // Відправляємо профіль-фото спочатку
  try {
    await bot.sendPhoto(userId, PROFILE_PHOTO_PATH)
  } catch (err) {
    console.warn('[bot] Failed to send profile photo:', err.message)
  }

  await safeSendMessage(userId, START_MESSAGE)
})

bot.onText(/\/restart/, async (msg) => {
  const userId = msg.chat.id
  try {
    await db.deleteSession(userId)
  } catch (err) {
    console.error('[bot] deleteSession error:', db.formatDbError(err))
  }
  await safeSendMessage(userId, `Починаємо спочатку! 🔄\n\n${START_MESSAGE}`)
})

bot.onText(/\/status/, async (msg) => {
  const userId = msg.chat.id
  try {
    const session = await db.getOrCreateSession(userId)
    const lanes = session.process_model?.lanes?.length || 0
    const nodes = (session.process_model?.lanes || []).reduce((s, l) => s + (l.nodes?.length || 0), 0)
    const status = session.status === 'complete' ? '✅ Завершено' : '🔄 В процесі'
    await safeSendMessage(userId,
      `📋 Статус вашої сесії:\n• Статус: ${status}\n• Ролей (swimlanes): ${lanes}\n• Кроків (вузлів): ${nodes}\n• Блок: ${session.current_block}/5`
    )
  } catch (err) {
    console.error('[bot] /status error:', err.message)
  }
})

// ─── Обробник всіх повідомлень ────────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (!msg.text) return
  if (msg.text.startsWith('/')) return // обробляється в onText

  const userId = msg.chat.id
  const text = msg.text.trim()

  if (!text) return

  await handleMessage(userId, text)
})

// ─── Обробник callback buttons ───────────────────────────────

bot.on('callback_query', async (query) => {
  const userId = query.from.id
  const action = query.data

  try {
    if (action === 'action_restart') {
      console.log(`[bot] User ${userId}: Clicked restart button`)
      await db.deleteSession(userId)
      await bot.answerCallbackQuery(query.id, { text: '🔄 Прискорінюючи...' })
      await safeSendMessage(userId, `Повернення до редагування ❀️\n\n${START_MESSAGE}`)
    } else if (action === 'action_download') {
      console.log(`[bot] User ${userId}: Clicked download button`)
      const session = await db.getOrCreateSession(userId)
      if (session.mermaid_code && session.process_model?.mermaid_code) {
        await bot.answerCallbackQuery(query.id, { text: '📑 Готово...' })
        await safeSendMessage(userId,
          `📋 Мермайд код:\n\`\`\`\n${session.mermaid_code.substring(0, 2000)}\n\`\`\`\n\n[Вкопіюйте чи використайте на mermaid.live]`)
      } else {
        await bot.answerCallbackQuery(query.id, { text: '❌ Схема не готова', show_alert: true })
      }
    }
  } catch (err) {
    console.error(`[bot] callback error User ${userId}:`, err.message)
    await bot.answerCallbackQuery(query.id, { text: '⚠️ Помилка', show_alert: true })
  }
})

// ─── Обробник голосових повідомлень ───────────────────────────────

bot.on('voice', async (msg) => {
  const userId = msg.chat.id
  console.log(`[bot] User ${userId}: Received voice message`)
  
  const voiceDescription = `[голосове повідомлення, ${Math.round(msg.voice.duration)}s]`
  await handleMessage(userId, voiceDescription)
})

// ─── Обробник документів ──────────────────────────────────────────────────────

bot.on('document', async (msg) => {
  const userId = msg.chat.id
  const fileName = msg.document?.file_name || 'невизначений файл'
  console.log(`[bot] User ${userId}: Received document: ${fileName}`)
  
  const docDescription = `[документ: ${fileName}]`
  await handleMessage(userId, docDescription)
})

// ─── Обробка помилок ──────────────────────────────────────────────────────────

bot.on('polling_error', (err) => {
  console.error('[bot] Polling error:', err.message)
})

bot.on('error', (err) => {
  console.error('[bot] General error:', err.message)
})

// ─── Допоміжні функції ────────────────────────────────────────────────────────

async function safeSendMessage(userId, text) {
  try {
    await bot.sendMessage(userId, text, { parse_mode: 'Markdown' })
  } catch (err) {
    // Якщо Markdown не пройшов — надсилаємо без форматування
    try {
      await bot.sendMessage(userId, text)
    } catch (err2) {
      console.error('[bot] safeSendMessage error:', err2.message)
    }
  }
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

console.log(`[bot] Starting business-process-agent...`)
console.log(`[bot] LLM Provider: ${config.llm.provider} | Model: ${config.llm.model}`)

bootstrap()

async function bootstrap() {
  startHealthServer()
  let dbReady = false
  try {
    await db.ensureReady({ retries: 10, delayMs: 5000 })
    dbReady = true
  } catch (err) {
    console.error('[bot] DB permanently unreachable after all retries:', db.formatDbError(err))
    console.error('[bot] Check DATABASE_URL variable in Railway Variables tab!')
    // НЕ падаємо — health server живий, але бот відповідатиме «технічна помилка»
  }
  if (dbReady) {
    console.log('[bot] Bot is fully running. Press Ctrl+C to stop.')
  } else {
    console.log('[bot] Bot started WITHOUT DB — will respond with error to users.')
  }
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, service: 'business-process-agent' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('OK')
  })

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[bot] Health server listening on 0.0.0.0:${PORT}`)
  })
}
