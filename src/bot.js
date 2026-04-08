'use strict'
require('./config') // Запускає валідацію env змінних одразу при старті

const TelegramBot = require('node-telegram-bot-api')
const http = require('http')
const fs = require('fs')
const path = require('path')
const config = require('./config')
const db = require('./db')
const { runInterviewStep, runValidator, runMermaidGenerator } = require('./agents')
const { transcribeAudio } = require('./llm')
const { renderMermaid } = require('./mermaidRender')

// ─── Константи ──────────────────────────────────────────────────────────────

const START_MESSAGE = `Привіт! Зараз ми побудуємо схему вашого бізнес-процесу — від того як клієнт дізнається про вас до моменту коли ви виконали замовлення і отримали оплату.

Я буду задавати питання по одному. Відповідайте як вам зручно — коротко або детально, я підлаштуюся.

Також можна відповідати:
- голосовими повідомленнями (Telegram voice; потрібен OPENAI_API_KEY для Whisper)
- документами TXT, PDF, DOCX (читаю текст з файлу)
- формат DOC поки не парситься автоматично

Почнемо? Розкажіть коротко — чим займається ваша компанія?`

const COMPLETION_MESSAGE = `Відмінно! Ось схема бізнес-процесу вашої компанії 👆

Зверніть увагу на ролі в лівій колонці — ми будемо використовувати цю схему на всіх наступних уроках.

На наступному кроці ми додамо в цю схему всі фінансові дії — де саме в процесі виникають гроші. Переходьте до уроку 1.4 ✅`

const PROFILE_PHOTO_PATH = path.join(__dirname, '..', 'profile.jpg')
const PORT = Number(process.env.PORT || 3000)
const SCENARIO_MAIN = 'main_process'

// ─── Telegram бот ────────────────────────────────────────────────────────────

const bot = new TelegramBot(config.telegram.token, { polling: true })

// ─── Головний обробник повідомлень ───────────────────────────────────────────

async function handleMessage(userId, text) {
  const isDocumentInput = typeof text === 'string' && text.startsWith('[з документа ')
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

  // Якщо вхід з документа — явно перевіряємо повноту моделі одразу.
  // valid=true -> відразу фіналізуємо, valid=false -> задаємо точне уточнююче питання.
  if (isDocumentInput) {
    console.log(`[bot] User ${userId}: Running completeness check for document input...`)
    try {
      const completeness = await runValidator(session.process_model)
      if (completeness?.valid) {
        console.log(`[bot] User ${userId}: Document appears complete, moving to finalization.`)
        agentResponse.isComplete = true
        if (!agentResponse.text || agentResponse.text.trim().length < 3) {
          agentResponse.text = 'Дякую, я проаналізував документ. Даних достатньо — формую фінальну схему.'
        }
      } else {
        const followUp = completeness?.errors?.[0]?.question_to_ask
        if (followUp) {
          const prefix = 'Я проаналізував документ. Щоб завершити схему, уточніть, будь ласка:'
          agentResponse.text = `${prefix}\n\n${followUp}`
        }
      }
    } catch (err) {
      console.error(`[bot] User ${userId}: Completeness check failed:`, err.message)
    }
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

bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const userId = msg.chat.id
  const payload = (match?.[1] || '').trim().toLowerCase() || SCENARIO_MAIN
  await launchScenario(userId, payload)
})

bot.onText(/\/restart/, async (msg) => {
  const userId = msg.chat.id
  await launchScenario(userId, SCENARIO_MAIN)
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
      await bot.answerCallbackQuery(query.id, { text: '🔄 Прискорінюючи...' })
      await launchScenario(userId, SCENARIO_MAIN)
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

  try {
    await safeSendMessage(userId, '🎙 Розпізнаю голосове повідомлення...')
    const audioBuffer = await downloadTelegramFile(msg.voice.file_id)
    const transcript = await transcribeAudio(audioBuffer, `voice_${msg.voice.file_unique_id || Date.now()}.ogg`)

    if (!transcript) {
      await safeSendMessage(userId, 'Не вдалося розпізнати текст у голосовому. Спробуйте ще раз або напишіть текстом.')
      return
    }

    console.log(`[bot] User ${userId}: Voice transcribed, len=${transcript.length}`)
    await safeSendMessage(userId, `📝 Розпізнано: ${transcript.substring(0, 160)}${transcript.length > 160 ? '...' : ''}`)
    await handleMessage(userId, transcript)
  } catch (err) {
    console.error(`[bot] User ${userId}: Voice transcription failed:`, err.message)
    await safeSendMessage(userId, 'Не вдалося обробити голосове. Перевірте OPENAI_API_KEY або надішліть текстом.')
  }
})

// ─── Обробник документів ──────────────────────────────────────────────────────

bot.on('document', async (msg) => {
  const userId = msg.chat.id
  const fileName = msg.document?.file_name || 'невизначений файл'
  const mimeType = msg.document?.mime_type || ''
  console.log(`[bot] User ${userId}: Received document: ${fileName}`)

  try {
    const fileId = msg.document?.file_id
    if (!fileId) {
      await safeSendMessage(userId, 'Не можу отримати цей документ. Спробуйте надіслати ще раз.')
      return
    }

    await safeSendMessage(userId, '📄 Читаю документ...')
    const fileBuffer = await downloadTelegramFile(fileId)
    console.log(`[bot] User ${userId}: Document meta: mime=${mimeType || 'n/a'}, size=${fileBuffer.length}`)
    const extractedText = await extractTextFromDocument(fileBuffer, fileName, mimeType)

    if (!extractedText) {
      await safeSendMessage(userId, 'Не вдалося прочитати текст з документа. Підтримуються: TXT, PDF, DOCX.')
      return
    }

    const normalized = extractedText.replace(/\s+/g, ' ').trim()
    const preview = normalized.substring(0, 240)
    await safeSendMessage(userId, `✅ Документ прочитано: ${fileName}\nФрагмент: ${preview}${normalized.length > 240 ? '...' : ''}`)

    const payload = `[з документа ${fileName}]\n${normalized.substring(0, 5000)}`
    await handleMessage(userId, payload)
  } catch (err) {
    console.error(`[bot] User ${userId}: Document processing failed:`, err.message, err.stack || '')
    await safeSendMessage(userId, 'Не вдалося обробити документ. Підтримуються: TXT, PDF, DOCX.')
  }
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

async function launchScenario(userId, payload) {
  const requestedScenario = payload || SCENARIO_MAIN

  try {
    await db.deleteSession(userId)
  } catch (err) {
    console.error('[bot] deleteSession error:', db.formatDbError(err))
  }

  // Відправляємо профіль-фото без підпису
  try {
    await bot.sendPhoto(userId, PROFILE_PHOTO_PATH)
  } catch (err) {
    console.warn('[bot] Failed to send profile photo:', err.message)
  }

  if (requestedScenario !== SCENARIO_MAIN) {
    await safeSendMessage(userId, 'Цей сценарій ще в розробці. Поки доступний тільки основний бізнес-процес.')
  }

  await safeSendMessage(userId, START_MESSAGE)
}

async function downloadTelegramFile(fileId) {
  const fileMeta = await bot.getFile(fileId)
  if (!fileMeta || !fileMeta.file_path) {
    throw new Error('Telegram did not return file_path for document')
  }
  const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${fileMeta.file_path}`
  const response = await fetch(fileUrl)
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: HTTP ${response.status}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

async function extractTextFromDocument(fileBuffer, fileName = '', mimeType = '') {
  const ext = path.extname(fileName).toLowerCase()

  if (ext === '.txt' || mimeType === 'text/plain') {
    return decodeTextBuffer(fileBuffer)
  }

  if (ext === '.pdf' || mimeType === 'application/pdf') {
    try {
      const pdfParse = require('pdf-parse')
      const result = await pdfParse(fileBuffer)
      return result.text || ''
    } catch (err) {
      throw new Error(`PDF parse failed: ${err.message}`)
    }
  }

  if (ext === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      const mammoth = require('mammoth')
      const result = await mammoth.extractRawText({ buffer: fileBuffer })
      return result.value || ''
    } catch (err) {
      throw new Error(`DOCX parse failed: ${err.message}`)
    }
  }

  if (ext === '.doc' || mimeType === 'application/msword') {
    return ''
  }

  // Якщо не вдалось визначити тип по розширенню — пробуємо як текст
  const asText = decodeTextBuffer(fileBuffer)
  if (asText.trim().length > 0) {
    return asText
  }

  return ''
}

function decodeTextBuffer(fileBuffer) {
  if (!fileBuffer || fileBuffer.length === 0) return ''

  // UTF-8
  let text = fileBuffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\u0000/g, '')
  if (text.trim().length > 0) return text

  // Latin-1 fallback (для випадків не-UTF8 txt)
  text = fileBuffer.toString('latin1').replace(/\u0000/g, '')
  return text
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
