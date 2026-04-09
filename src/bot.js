'use strict'
process.env.NTBA_FIX_350 = 1 // Use improved file content-type detection
require('./config') // Запускає валідацію env змінних одразу при старті

const TelegramBot = require('node-telegram-bot-api')
const http = require('http')
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
const MAX_VALIDATION_ATTEMPTS = 3
const WEBHOOK_PATH = normalizeWebhookPath(config.telegram.webhookPath)
const WEBHOOK_URL = buildWebhookUrl(config.telegram.webhookBaseUrl, WEBHOOK_PATH)

// ─── Telegram бот ────────────────────────────────────────────────────────────

const bot = new TelegramBot(config.telegram.token)

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
    await sendChatAction(userId, 'typing')
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
      await sendChatAction(userId, 'typing')
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
    await sendChatAction(userId, 'typing')
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
    await sendChatAction(userId, 'upload_document')
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
    console.log(`[bot] User ${userId}: Sending final schema photo...`)
    await bot.sendPhoto(userId, pngBuffer, {
      caption: '📋 Схема бізнес-процесу вашої компанії'
    }, { contentType: 'image/png' })
  } catch (err) {
    console.error('[bot] sendPhoto error:', err.message)
    await safeSendMessage(userId, '📊 Схема отримана')
  }

  await sendCompletionActions(userId)
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

  try {
    await handleMessage(userId, text)
  } catch (err) {
    console.error(`[bot] Unhandled message error user=${userId}:`, err.message)
    await safeSendMessage(userId, 'Сталася помилка обробки повідомлення. Спробуйте ще раз.')
  }
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
        await sendProcessFiles(userId, session)
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
    await sendChatAction(userId, 'typing')
    await safeSendMessage(userId, '🎙 Розпізнаю голосове повідомлення...')
    const audioBuffer = await downloadTelegramFile(msg.voice.file_id)
    await sendChatAction(userId, 'typing')
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

    await sendChatAction(userId, 'typing')
    await safeSendMessage(userId, '📄 Читаю документ...')
    const fileBuffer = await downloadTelegramFile(fileId)
    console.log(`[bot] User ${userId}: Document meta: mime=${mimeType || 'n/a'}, size=${fileBuffer.length}`)
    const extractedText = await extractTextFromDocument(fileBuffer, fileName, mimeType)

    if (!extractedText) {
      await safeSendMessage(userId, 'Не вдалося прочитати текст з документа. Підтримуються: TXT, PDF, DOCX.')
      return
    }

    const normalized = extractedText.replace(/\s+/g, ' ').trim()

    const payload = `[з документа ${fileName}]\n${normalized.substring(0, 5000)}`
    await handleMessage(userId, payload)
  } catch (err) {
    console.error(`[bot] User ${userId}: Document processing failed:`, err.message, err.stack || '')
    await safeSendMessage(userId, 'Не вдалося обробити документ. Підтримуються: TXT, PDF, DOCX.')
  }
})

process.on('unhandledRejection', (reason) => {
  console.error('[bot] Unhandled rejection:', reason)
})

process.on('uncaughtException', (err) => {
  console.error('[bot] Uncaught exception:', err)
})

// ─── Обробка помилок ──────────────────────────────────────────────────────────

bot.on('webhook_error', (err) => {
  console.error('[bot] Webhook error:', err.message)
})

bot.on('error', (err) => {
  console.error('[bot] General error:', err.message)
})

// ─── Допоміжні функції ────────────────────────────────────────────────────────

async function safeSendMessage(userId, text) {
  const chunks = splitMessageChunks(String(text || ''))
  for (const chunk of chunks) {
    try {
      await bot.sendMessage(userId, chunk, { parse_mode: 'Markdown' })
    } catch {
      // Якщо Markdown не пройшов — надсилаємо без форматування
      try {
        await bot.sendMessage(userId, chunk)
      } catch (err2) {
        console.error('[bot] safeSendMessage error:', err2.message)
      }
    }
  }
}

async function sendChatAction(userId, action = 'typing') {
  try {
    await bot.sendChatAction(userId, action)
  } catch {
    // Ignore chat action errors; they should not break message flow.
  }
}

async function sendCompletionActions(userId) {
  const text = `${COMPLETION_MESSAGE}\n\nОберіть дію нижче:`
  try {
    await bot.sendMessage(userId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Повернутись і відредагувати ще щось', callback_data: 'action_restart' },
            { text: 'Отримати опис процесу', callback_data: 'action_download' },
          ],
        ],
      },
    })
  } catch (err) {
    console.error('[bot] sendCompletionActions markdown error:', err.message)
    await bot.sendMessage(userId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Повернутись і відредагувати ще щось', callback_data: 'action_restart' },
            { text: 'Отримати опис процесу', callback_data: 'action_download' },
          ],
        ],
      },
    })
  }
}

async function sendProcessFiles(userId, session) {
  // 1) PNG схема
  let pngBuffer
  try {
    await sendChatAction(userId, 'upload_document')
    pngBuffer = await renderMermaid(session.mermaid_code)
  } catch (err) {
    console.error('[bot] Failed to render mermaid for download:', err.message)
    await safeSendMessage(userId, 'Не вдалося підготувати PNG схеми. Спробуйте ще раз.')
    return
  }

  await sendChatAction(userId, 'upload_document')
  await bot.sendDocument(
    userId,
    pngBuffer,
    { caption: 'Файл 1/2: бізнес-процес (PNG)' },
    { filename: 'business_process.png', contentType: 'image/png' }
  )

  // 2) JSON модель
  const jsonString = JSON.stringify(session.process_model, null, 2)
  const jsonBuffer = Buffer.from(jsonString, 'utf8')
  await sendChatAction(userId, 'upload_document')
  await bot.sendDocument(
    userId,
    jsonBuffer,
    { caption: 'Файл 2/2: модель процесу (JSON)' },
    { filename: 'process_model.json', contentType: 'application/json' }
  )
}

function splitMessageChunks(text, maxLen = 3500) {
  if (!text) return ['']
  if (text.length <= maxLen) return [text]

  const parts = []
  let current = text
  while (current.length > maxLen) {
    // Прагнемо різати по переносу рядка, щоб не ламати читабельність
    let cut = current.lastIndexOf('\n', maxLen)
    if (cut < 0 || cut < Math.floor(maxLen * 0.5)) {
      cut = maxLen
    }
    parts.push(current.slice(0, cut).trim())
    current = current.slice(cut).trim()
  }
  if (current.length > 0) {
    parts.push(current)
  }
  return parts
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

function buildCompletenessChecklist(processModel) {
  const lanes = Array.isArray(processModel?.lanes) ? processModel.lanes : []
  const edges = Array.isArray(processModel?.edges) ? processModel.edges : []
  const nodes = lanes.flatMap((lane) => Array.isArray(lane.nodes) ? lane.nodes : [])
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  const incoming = new Map()
  const outgoing = new Map()
  for (const n of nodes) {
    incoming.set(n.id, 0)
    outgoing.set(n.id, 0)
  }

  let edgesReferenceKnownNodesOnly = true
  for (const e of edges) {
    const from = e?.from
    const to = e?.to
    if (!nodeById.has(from) || !nodeById.has(to)) {
      edgesReferenceKnownNodesOnly = false
      continue
    }
    outgoing.set(from, (outgoing.get(from) || 0) + 1)
    incoming.set(to, (incoming.get(to) || 0) + 1)
  }

  const startNodes = nodes.filter((n) => n.type === 'start')
  const endNodes = nodes.filter((n) => n.type === 'end')
  const hasExactlyOneStart = startNodes.length === 1
  const hasAtLeastOneEnd = endNodes.length > 0

  const allNonStartHaveIncoming = nodes
    .filter((n) => n.type !== 'start')
    .every((n) => (incoming.get(n.id) || 0) > 0)

  const allNonEndHaveOutgoing = nodes
    .filter((n) => n.type !== 'end')
    .every((n) => (outgoing.get(n.id) || 0) > 0)

  const danglingNodesCount = nodes.filter((n) => {
    const inCount = incoming.get(n.id) || 0
    const outCount = outgoing.get(n.id) || 0
    return inCount === 0 && outCount === 0
  }).length

  const hasPathStartToEnd = checkPathFromStartToAnyEnd(startNodes, endNodes, edges, nodeById)

  const textBag = [
    ...lanes.map((l) => `${l.role || ''} ${l.responsible || ''}`),
    ...nodes.map((n) => `${n.label || ''} ${n.description || ''}`),
  ].join(' ').toLowerCase()

  const hasAcquisitionBlock = /(лід|заявк|реклам|маркет|instagram|facebook|google ads|трафік|дзвінок)/.test(textBag)
  const hasSalesBlock = /(продаж|кваліф|кп|комерційн|пропозиці|договір|згода)/.test(textBag)
  const hasOperationsBlock = /(викон|вироб|надання послуг|послуга|проєкт|доставка|реалізац)/.test(textBag)
  const hasPaymentBlock = /(оплат|рахунок|платіж|акт|invoice|каса|банківськ)/.test(textBag)

  const hasFinanceLane = lanes.some((l) => {
    const role = `${l.role || ''} ${l.responsible || ''}`.toLowerCase()
    return /(фінанс|бухгалтер|облік|account|finance)/.test(role)
  })

  return [
    { ok: hasExactlyOneStart, label: 'Є рівно один стартовий вузол' },
    { ok: hasAtLeastOneEnd, label: 'Є хоча б один фінальний вузол' },
    { ok: allNonStartHaveIncoming, label: 'Кожен вузол (крім start) має вхідні звʼязки' },
    { ok: allNonEndHaveOutgoing, label: 'Кожен вузол (крім end) має вихідні звʼязки' },
    { ok: edgesReferenceKnownNodesOnly, label: 'Усі ребра посилаються на існуючі вузли' },
    { ok: hasPathStartToEnd, label: 'Є логічний шлях від start до end' },
    { ok: danglingNodesCount === 0, label: 'Немає висячих вузлів без звʼязків' },
    { ok: hasAcquisitionBlock, label: 'Є блок залучення клієнта' },
    { ok: hasSalesBlock, label: 'Є блок продажу/кваліфікації' },
    { ok: hasOperationsBlock, label: 'Є блок виконання/операцій' },
    { ok: hasPaymentBlock, label: 'Є блок оплати і закриття' },
    { ok: hasFinanceLane, label: 'Є фінансова роль (бухгалтер/фінанси)' },
  ]
}

function checkPathFromStartToAnyEnd(startNodes, endNodes, edges, nodeById) {
  if (!startNodes.length || !endNodes.length) return false

  const endIds = new Set(endNodes.map((n) => n.id))
  const adjacency = new Map()
  for (const n of nodeById.values()) {
    adjacency.set(n.id, [])
  }

  for (const e of edges) {
    if (adjacency.has(e?.from) && adjacency.has(e?.to)) {
      adjacency.get(e.from).push(e.to)
    }
  }

  const queue = [startNodes[0].id]
  const visited = new Set(queue)
  while (queue.length > 0) {
    const cur = queue.shift()
    if (endIds.has(cur)) return true
    const next = adjacency.get(cur) || []
    for (const n of next) {
      if (!visited.has(n)) {
        visited.add(n)
        queue.push(n)
      }
    }
  }
  return false
}

function formatChecklistMessage(checklist) {
  const done = checklist.filter((c) => c.ok).length
  const total = checklist.length
  const lines = checklist.map((c) => `${c.ok ? '✅' : '❌'} ${c.label}`)
  return `Чекліст повноти процесу (${done}/${total}):\n\n${lines.join('\n')}`
}

function buildFollowUpFromChecklist(checklist) {
  const firstMissing = checklist.find((c) => !c.ok)
  if (!firstMissing) return ''

  if (firstMissing.label.includes('стартовий вузол')) {
    return 'З чого починається ваш процес: як саме зʼявляється новий клієнт або заявка?'
  }
  if (firstMissing.label.includes('фінальний вузол')) {
    return 'Яка кінцева точка процесу: що саме вважаємо завершенням роботи з клієнтом?'
  }
  if (firstMissing.label.includes('залучення клієнта')) {
    return 'Опишіть, будь ласка, етап залучення клієнта: звідки приходить лід і хто його обробляє першим?'
  }
  if (firstMissing.label.includes('продажу/кваліфікації')) {
    return 'Опишіть етап продажу: як кваліфікуєте клієнта, робите пропозицію і отримуєте підтвердження?'
  }
  if (firstMissing.label.includes('виконання/операцій')) {
    return 'Опишіть етап виконання: які ключові кроки після погодження з клієнтом і хто за них відповідає?'
  }
  if (firstMissing.label.includes('оплати і закриття')) {
    return 'Як відбувається оплата і закриття угоди: хто виставляє рахунок, хто контролює надходження, що є фінальним кроком?'
  }
  if (firstMissing.label.includes('фінансова роль')) {
    return 'Хто у вас відповідає за фінансову частину: оплати, облік і звітність?'
  }
  return 'Є ще одна прогалина в процесі. Уточніть, будь ласка, що відбувається між поточними кроками, щоб ланцюжок був повним.'
}

function normalizeWebhookPath(rawPath) {
  const value = String(rawPath || '/telegram/webhook').trim()
  return value.startsWith('/') ? value : `/${value}`
}

function buildWebhookUrl(baseUrl, webhookPath) {
  const normalizedBase = String(baseUrl || '').trim().replace(/\/+$/, '')
  return normalizedBase ? `${normalizedBase}${webhookPath}` : ''
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, mode: 'webhook' }))
      return
    }

    if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
      try {
        if (config.telegram.webhookSecret) {
          const secretHeader = req.headers['x-telegram-bot-api-secret-token']
          if (secretHeader !== config.telegram.webhookSecret) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'invalid webhook secret' }))
            return
          }
        }

        const rawBody = await readRequestBody(req)
        const update = JSON.parse(rawBody.toString('utf8') || '{}')
        await bot.processUpdate(update)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        console.error('[bot] Webhook request error:', err.message)
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false }))
      }
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'not found' }))
  })

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[bot] Health server listening on 0.0.0.0:${PORT}`)
    console.log(`[bot] Webhook endpoint ready at ${WEBHOOK_PATH}`)
  })

  return server
}

async function logWebhookStatus() {
  try {
    const info = await bot.getWebHookInfo()
    console.log(`[bot] Webhook status: url=${info.url || 'n/a'}, pending_updates=${info.pending_update_count || 0}`)
    if (info.last_error_message) {
      console.error(`[bot] Webhook last error: ${info.last_error_message}`)
    }
    if (info.last_synchronization_error_date) {
      console.error(`[bot] Webhook last sync error date: ${info.last_synchronization_error_date}`)
    }
  } catch (err) {
    console.error('[bot] Failed to read Telegram webhook status:', err.message)
  }
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

console.log(`[bot] Starting business-process-agent...`)
console.log(`[bot] LLM Provider: ${config.llm.provider} | Model: ${config.llm.model}`)

bootstrap()

async function bootstrap() {
  startHttpServer()
  let dbReady = false
  try {
    await db.ensureReady({ retries: 10, delayMs: 5000 })
    dbReady = true
  } catch (err) {
    console.error('[bot] DB permanently unreachable after all retries:', db.formatDbError(err))
    console.error('[bot] Check DATABASE_URL variable in Railway Variables tab!')
    // НЕ падаємо — health server живий, але бот відповідатиме «технічна помилка»
  }
  if (!WEBHOOK_URL) {
    console.error('[bot] TELEGRAM_WEBHOOK_URL / RAILWAY_PUBLIC_DOMAIN is not configured; webhook registration skipped.')
    console.error('[bot] Set TELEGRAM_WEBHOOK_URL or expose the app through Railway public domain.')
  } else {
    try {
      await bot.setWebHook(WEBHOOK_URL, config.telegram.webhookSecret
        ? { secret_token: config.telegram.webhookSecret }
        : {})
      console.log(`[bot] Telegram webhook registered: ${WEBHOOK_URL}`)
      await logWebhookStatus()
    } catch (err) {
      console.error('[bot] Failed to register Telegram webhook:', err.message)
    }
  }

  if (dbReady) {
    console.log('[bot] Bot is fully running. Press Ctrl+C to stop.')
  } else {
    console.log('[bot] Bot started WITHOUT DB — will respond with error to users.')
  }
}
