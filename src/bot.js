'use strict'
process.env.NTBA_FIX_350 = 1 // Use improved file content-type detection
require('./config') // Запускає валідацію env змінних одразу при старті

const TelegramBot = require('node-telegram-bot-api')
const http = require('http')
const fs = require('fs')
const path = require('path')
const config = require('./config')
const db = require('./db')
const {
  normalizeFinancialMechanicsSession: normalizeFinancialMechanicsSessionFn,
  hasFinancialMechanicsContext: hasFinancialMechanicsContextFn,
  buildFinancialMechanicsContextRequestMessage: buildFinancialMechanicsContextRequestMessageFn,
  buildFinancialMechanicsStartMessage: buildFinancialMechanicsStartMessageFn,
  buildFinancialMechanicsFallbackQuestion: buildFinancialMechanicsFallbackQuestionFn,
  getMissingFinancialMechanicsSections: getMissingFinancialMechanicsSectionsFn,
  isAnyValueFilled: isAnyValueFilledFn,
  buildFinancialMechanicsDocument: buildFinancialMechanicsDocumentFn,
  isFinancialMechanicsTrigger: isFinancialMechanicsTriggerFn,
} = require('./financialMechanics')
const {
  runInterviewStep,
  runCashflowInterviewStep,
  runFinancialMechanicsInterviewStep,
  runValidator,
  runMermaidGenerator,
} = require('./agents')
const { transcribeAudio } = require('./llm')
const { renderMermaid } = require('./mermaidRender')

// ─── Константи ──────────────────────────────────────────────────────────────

const MAIN_START_MESSAGE = `Привіт! Зараз ми побудуємо схему вашого бізнес-процесу — від того як клієнт дізнається про вас до моменту коли ви виконали замовлення і отримали оплату.

Я буду задавати питання по одному. Відповідайте як вам зручно — коротко або детально, я підлаштуюся.

Також можна відповідати:
- голосовими повідомленнями (Telegram voice; потрібен OPENAI_API_KEY для Whisper)
- документами TXT, PDF, DOCX (читаю текст з файлу)
- формат DOC поки не парситься автоматично

Почнемо? Розкажіть коротко — чим займається ваша компанія?`

const MAIN_COMPLETION_MESSAGE = `Відмінно! Ось схема бізнес-процесу вашої компанії 👆

Зверніть увагу на ролі в лівій колонці — ми будемо використовувати цю схему на всіх наступних уроках.

На наступному кроці ми додамо в цю схему всі фінансові дії — де саме в процесі виникають гроші. Переходьте до уроку 1.4 ✅`

const PROFILE_PHOTO_PATH = path.join(__dirname, '..', 'profile.jpg')
const CASHFLOW_INSTRUCTION_DOC_PATH = path.join(__dirname, '..', 'docs', 'instructions', 'Cashflow_Статті_та_інструкції.docx')
const PL_INSTRUCTION_DOC_PATH = path.join(__dirname, '..', 'docs', 'instructions', 'PL_Статті_та_інструкції.docx')
const PORT = Number(process.env.PORT || 3000)
const SCENARIO_MAIN = 'main_process'
const SCENARIO_CASHFLOW = 'cashflow_items'
const SCENARIO_FINANCIAL_MECHANICS = 'financial_mechanics_diagnosis'
const MAX_VALIDATION_ATTEMPTS = 3
const WEBHOOK_PATH = normalizeWebhookPath(config.telegram.webhookPath)
const WEBHOOK_URL = buildWebhookUrl(config.telegram.webhookBaseUrl, WEBHOOK_PATH)
let httpServer = null
let isShuttingDown = false
const processedUpdateIds = new Set()

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

  if (session.current_scenario === SCENARIO_CASHFLOW) {
    await handleCashflowMessage(userId, text, session)
    return
  }

  if (session.current_scenario === SCENARIO_FINANCIAL_MECHANICS) {
    await handleFinancialMechanicsMessage(userId, text, session)
    return
  }

  if (session.status === 'complete') {
    await safeSendMessage(userId, 'Ваш процес вже побудований 🎉\n\nНадішліть /restart щоб почати заново.')
    return
  }

  // Додаємо повідомлення користувача в історію
  session.history.push({ role: 'user', content: text })

  // Якщо великий ввід — одразу повідомляємо що обробляємо
  const isLargeInput = text.length > 500
  if (isLargeInput) {
    await safeSendMessage(userId, '⏳ Аналізую ваш опис, це займе кілька секунд...')
  }

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

  // Єдиний флоу достатності даних: якщо модель вже достатньо повна,
  // завершуємо сценарій навіть якщо LLM не додав явний completion marker.
  if (!agentResponse.isComplete) {
    try {
      await sendChatAction(userId, 'typing')
      const sufficiencyValidation = await runValidator(session.process_model)
      const checklist = buildCompletenessChecklist(session.process_model)

      const coreCoverage = [7, 8, 9, 10, 11].every((idx) => checklist[idx]?.ok)
      const structuralCoverage = [0, 1, 5].every((idx) => checklist[idx]?.ok)
      const sufficientForFinalization = Boolean(sufficiencyValidation?.valid) || (coreCoverage && structuralCoverage)

      if (sufficientForFinalization) {
        agentResponse.isComplete = true
        if (!agentResponse.text || !agentResponse.text.trim()) {
          agentResponse.text = 'Дякую, інформації достатньо. Формую фінальну схему процесу.'
        }
        console.log(`[bot] User ${userId}: Auto-complete enabled by unified sufficiency check.`)
      }
    } catch (err) {
      console.error(`[bot] User ${userId}: Unified sufficiency check failed:`, err.message)
    }
  }

  // Fallback: інколи модель повертає лише технічний блок без тексту для користувача.
  // Щоб бот не мовчав, генеруємо уточнююче питання на основі поточної моделі.
  if (!agentResponse.isComplete && (!agentResponse.text || !agentResponse.text.trim())) {
    const checklist = buildCompletenessChecklist(session.process_model)
    const followUp = buildFollowUpFromChecklist(checklist)
    agentResponse.text = followUp
      ? `Дякую, я зафіксував інформацію. Уточніть, будь ласка:

${followUp}`
      : 'Дякую, я зафіксував інформацію. Щоб завершити схему, уточніть, будь ласка, хто відповідає за фінальний крок закриття угоди?'
    console.warn(`[bot] User ${userId}: Interview agent returned empty bot text, fallback question sent.`)
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
    await safeSendMessage(userId, MAIN_COMPLETION_MESSAGE)
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
    await safeSendMessage(userId, MAIN_COMPLETION_MESSAGE)
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

async function handleCashflowMessage(userId, text, session) {
  if (session.cashflow_session?.status === 'complete' || session.status === 'complete') {
    await safeSendMessage(userId, 'Список статей для ваших звітів уже зібрано. Надішліть /restart, якщо хочете пройти цей блок ще раз.')
    return
  }

  if (!hasCompletedProcessModel(session.process_model)) {
    const awaitingFile = Boolean(session.cashflow_session?.awaiting_process_model_file)
    if (awaitingFile) {
      await safeSendMessage(userId, 'Щоб не повторювати вже пройдені питання, надішліть файл process_model.json з описом вашого бізнес-процесу.')
      return
    }

    await safeSendMessage(userId, 'Поки не бачу збереженого опису вашого бізнес-процесу. Надішліть файл process_model.json, або спочатку заповніть блок з описом процесу.')
    return
  }

  const cashflowSession = normalizeCashflowSession(session.cashflow_session)
  const history = Array.isArray(session.history) ? session.history : []
  history.push({ role: 'user', content: text })
  cashflowSession.history.push({ role: 'user', content: text })

  let agentResponse
  try {
    await sendChatAction(userId, 'typing')
    agentResponse = await runCashflowInterviewStep({
      processModel: session.process_model,
      cashflowSession,
      history,
      itemsLibrary: getItemsLibrary(session.process_model?.business_type),
      teamRoles: extractTeamRoles(session.process_model),
    })
  } catch (err) {
    console.error('[bot] Cashflow agent error:', err.message)
    cashflowSession.history.pop()
    history.pop()
    session.cashflow_session = cashflowSession
    session.history = history
    await db.saveSession(session)
    await safeSendMessage(userId, 'Не вдалося отримати відповідь від ШІ для Cashflow. Спробуйте ще раз.')
    return
  }

  const nextCashflowSession = agentResponse.updatedSession
    ? normalizeCashflowSession(agentResponse.updatedSession)
    : cashflowSession

  let botText = agentResponse.text
  if (!agentResponse.isComplete && (!botText || !botText.trim())) {
    botText = buildCashflowFallbackQuestion(nextCashflowSession)
  }

  if (botText) {
    history.push({ role: 'assistant', content: botText })
    nextCashflowSession.history.push({ role: 'assistant', content: botText })
  }

  nextCashflowSession.status = agentResponse.isComplete ? 'complete' : 'in_progress'
  session.cashflow_session = nextCashflowSession
  session.financial_reports_model = buildFinancialReportsModel(session, nextCashflowSession)
  session.history = history
  session.status = agentResponse.isComplete ? 'complete' : 'draft'

  try {
    await db.saveSession(session)
  } catch (err) {
    console.error('[bot] DB saveSession error:', err.message)
  }

  if (!agentResponse.isComplete) {
    if (botText) {
      await safeSendMessage(userId, botText)
    }
    return
  }

  await safeSendMessage(userId, buildCashflowCompletionMessage(nextCashflowSession))
  await sendCompletionActions(userId, SCENARIO_CASHFLOW)
}

async function handleFinancialMechanicsMessage(userId, text, session) {
  const financialSession = normalizeFinancialMechanicsSession(session.financial_mechanics_session)

  if (!hasFinancialMechanicsContext(session, financialSession)) {
    financialSession.awaiting_context_files = true
    session.financial_mechanics_session = financialSession
    await db.saveSession(session)
    await safeSendMessage(userId, buildFinancialMechanicsContextRequestMessage())
    return
  }

  financialSession.awaiting_context_files = false
  session.financial_mechanics_session = financialSession

  const history = Array.isArray(session.history) ? session.history : []
  history.push({ role: 'user', content: text })
  financialSession.history.push({ role: 'user', content: text })

  let agentResponse
  try {
    await sendChatAction(userId, 'typing')
    agentResponse = await runFinancialMechanicsInterviewStep({
      processModel: session.process_model,
      cashflowSession: session.cashflow_session,
      financialMechanicsSession: financialSession,
      history,
      plArticlesContext: buildPlArticlesContext(session, financialSession),
    })
  } catch (err) {
    console.error('[bot] Financial mechanics agent error:', err.message)
    history.pop()
    financialSession.history.pop()
    session.financial_mechanics_session = financialSession
    session.history = history
    await db.saveSession(session)
    await safeSendMessage(userId, 'Не вдалося отримати відповідь від ШІ для діагностики. Спробуйте ще раз.')
    return
  }

  const nextFinancialSession = agentResponse.updatedSession
    ? normalizeFinancialMechanicsSession(agentResponse.updatedSession)
    : financialSession

  let botText = agentResponse.text
  if (!agentResponse.isComplete && (!botText || !botText.trim())) {
    botText = buildFinancialMechanicsFallbackQuestion(nextFinancialSession)
  }

  if (botText) {
    history.push({ role: 'assistant', content: botText })
    nextFinancialSession.history.push({ role: 'assistant', content: botText })
  }

  nextFinancialSession.status = agentResponse.isComplete ? 'complete' : 'in_progress'
  session.financial_mechanics_session = nextFinancialSession
  session.history = history
  session.current_scenario = SCENARIO_FINANCIAL_MECHANICS

  if (!agentResponse.isComplete) {
    session.status = 'draft'
    await db.saveSession(session)
    if (botText) {
      await safeSendMessage(userId, botText)
    }
    return
  }

  const markdown = buildFinancialMechanicsDocument(session, nextFinancialSession)
  const missingBlocks = getMissingFinancialMechanicsSections(nextFinancialSession)
  if (missingBlocks.length > 0) {
    session.status = 'draft'
    nextFinancialSession.status = 'in_progress'
    await db.saveSession(session)
    await safeSendMessage(userId, `Блок ${missingBlocks[0]} не заповнений. Хочеш повернутись і уточнити?`)
    return
  }

  const diagnosisDate = new Date().toISOString()
  session.financial_mechanics_model = {
    business_type: session.process_model?.business_type || 'не вказано',
    diagnosis_date: diagnosisDate,
    markdown,
    status: 'complete',
  }
  nextFinancialSession.last_diagnosis_at = diagnosisDate
  nextFinancialSession.status = 'complete'
  session.status = 'complete'

  await db.saveSession(session)

  await safeSendMessage(userId, `✅ Діагностика завершена.

Я зберіг опис фінансової механіки твого бізнесу у файл financial_mechanics.md.

Що далі:
— Цей файл буде використаний у блоці 4 для побудови регламенту і інструкцій команді
— Якщо щось змінилось — можеш пройти діагностику повторно`)

  await sendFinancialMechanicsFile(userId, session)
  await sendCompletionActions(userId, SCENARIO_FINANCIAL_MECHANICS)
}

function normalizeFinancialMechanicsSession(financialMechanicsSession) {
  return normalizeFinancialMechanicsSessionFn(financialMechanicsSession)
}

function hasFinancialMechanicsContext(session, financialSession) {
  return hasFinancialMechanicsContextFn(session, financialSession)
}

function buildFinancialMechanicsContextRequestMessage() {
  return buildFinancialMechanicsContextRequestMessageFn()
}

function buildFinancialMechanicsStartMessage(processModel) {
  return buildFinancialMechanicsStartMessageFn(processModel)
}

function buildPlArticlesContext(session, financialSession) {
  const cashflow = normalizeCashflowSession(session.cashflow_session)
  const collected = {
    cashflow_items: cashflow.items,
    imported_cashflow_articles: financialSession?.imported_documents?.cashflow_articles || '',
    imported_pl_articles: financialSession?.imported_documents?.pl_articles || '',
  }
  return JSON.stringify(collected, null, 2)
}

function buildFinancialMechanicsFallbackQuestion(financialSession) {
  return buildFinancialMechanicsFallbackQuestionFn(financialSession)
}

function getMissingFinancialMechanicsSections(financialSession) {
  return getMissingFinancialMechanicsSectionsFn(financialSession)
}

function isAnyValueFilled(obj) {
  return isAnyValueFilledFn(obj)
}

function buildFinancialMechanicsDocument(session, financialSession) {
  return buildFinancialMechanicsDocumentFn(session.process_model, financialSession)
}

function normalizeCashflowSession(cashflowSession) {
  const items = cashflowSession?.items || {}
  const normalized = {
    items: {
      income: Array.isArray(items.income) ? items.income : [],
      cogs: Array.isArray(items.cogs) ? items.cogs : [],
      team: Array.isArray(items.team) ? items.team : [],
      operations: Array.isArray(items.operations) ? items.operations : [],
      taxes: Array.isArray(items.taxes) ? items.taxes : [],
    },
    completed_blocks: Array.isArray(cashflowSession?.completed_blocks) ? cashflowSession.completed_blocks : [],
    history: Array.isArray(cashflowSession?.history) ? cashflowSession.history : [],
    pl_structure: normalizePlStructure(cashflowSession?.pl_structure),
    awaiting_process_model_file: Boolean(cashflowSession?.awaiting_process_model_file),
    items_count: 0,
    status: cashflowSession?.status || 'draft',
  }

  normalized.items = normalizeCashflowItems(normalized.items)

  normalized.items_count = Object.values(normalized.items).reduce((sum, list) => sum + list.length, 0)
  normalized.pl_structure = buildPLStructure(normalized.items)
  return normalized
}

function buildFinancialReportsModel(session, cashflowSession) {
  return {
    session_id: session.process_model?.session_id || session.id,
    telegram_id: session.telegram_id,
    business_type: session.process_model?.business_type || '',
    cashflow_items: cashflowSession.items,
    pl_structure: cashflowSession.pl_structure,
    items_count: cashflowSession.items_count,
    source: 'cashflow_items',
    status: cashflowSession.status,
  }
}

function normalizeCashflowItems(items) {
  const applyDefaults = (entry) => {
    const costType = normalizeCostType(entry?.cost_type, entry?.name)
    return {
      id: entry?.id || '',
      name: entry?.name || '',
      cost_type: costType,
      frequency: normalizeFrequency(entry?.frequency),
      is_regular: typeof entry?.is_regular === 'boolean' ? entry.is_regular : inferRegularFromFrequency(entry?.frequency),
      pl_level: normalizePlLevel(entry?.pl_level, costType),
      notes: entry?.notes || '',
    }
  }

  return {
    income: Array.isArray(items.income) ? items.income.map(applyDefaults) : [],
    cogs: Array.isArray(items.cogs) ? items.cogs.map(applyDefaults) : [],
    team: Array.isArray(items.team) ? items.team.map(applyDefaults) : [],
    operations: Array.isArray(items.operations) ? items.operations.map(applyDefaults) : [],
    taxes: Array.isArray(items.taxes) ? items.taxes.map(applyDefaults) : [],
  }
}

function normalizePlStructure(plStructure) {
  const normalized = plStructure || {}
  return {
    revenue: Array.isArray(normalized.revenue) ? normalized.revenue : [],
    cogs: Array.isArray(normalized.cogs) ? normalized.cogs : [],
    gross_profit: normalized.gross_profit || 'revenue - cogs',
    opex: Array.isArray(normalized.opex) ? normalized.opex : [],
    operating_profit: normalized.operating_profit || 'gross_profit - opex',
    owner_payout: Array.isArray(normalized.owner_payout) ? normalized.owner_payout : [],
    pre_tax_profit: normalized.pre_tax_profit || 'operating_profit - owner_payout',
    taxes: Array.isArray(normalized.taxes) ? normalized.taxes : [],
    net_profit: normalized.net_profit || 'pre_tax_profit - taxes',
  }
}

function normalizeFrequency(value) {
  const allowed = new Set(['monthly', 'quarterly', 'annual', 'project_based', 'irregular'])
  const normalized = String(value || '').trim().toLowerCase()
  if (allowed.has(normalized)) return normalized
  return 'monthly'
}

function inferRegularFromFrequency(value) {
  const frequency = normalizeFrequency(value)
  return frequency === 'monthly' || frequency === 'quarterly' || frequency === 'annual'
}

function normalizeCostType(value, name = '') {
  const normalized = String(value || '').trim().toLowerCase()
  if (['income', 'cogs', 'opex', 'owner', 'tax'].includes(normalized)) {
    return normalized
  }

  const lowerName = String(name || '').toLowerCase()
  if (/(подат|єсв|пдв|коміс|еквайринг|bank)/.test(lowerName)) return 'tax'
  if (/(власник|дивіденд|owner)/.test(lowerName)) return 'owner'
  return 'opex'
}

function normalizePlLevel(value, costType) {
  const normalized = String(value || '').trim().toLowerCase()
  if (['revenue', 'gross_profit', 'operating_profit', 'pre_tax_profit', 'net_profit'].includes(normalized)) {
    return normalized
  }

  if (costType === 'income') return 'revenue'
  if (costType === 'cogs') return 'gross_profit'
  if (costType === 'owner') return 'pre_tax_profit'
  if (costType === 'tax') return 'net_profit'
  return 'operating_profit'
}

function buildPLStructure(items) {
  const allItems = [
    ...(items.income || []),
    ...(items.cogs || []),
    ...(items.team || []),
    ...(items.operations || []),
    ...(items.taxes || []),
  ]

  const idsByCostType = (costType) => allItems.filter((item) => item.cost_type === costType).map((item) => item.id).filter(Boolean)

  return {
    revenue: idsByCostType('income'),
    cogs: idsByCostType('cogs'),
    gross_profit: 'revenue - cogs',
    opex: idsByCostType('opex'),
    operating_profit: 'gross_profit - opex',
    owner_payout: idsByCostType('owner'),
    pre_tax_profit: 'operating_profit - owner_payout',
    taxes: idsByCostType('tax'),
    net_profit: 'pre_tax_profit - taxes',
  }
}

function getItemsLibrary(rawBusinessType) {
  const businessType = normalizeBusinessType(rawBusinessType)
  const libraries = {
    послуги: {
      income: ['Послуги (основні)', 'Проєктна робота', 'Ретейнер / абонплата', 'Навчання і воркшопи'],
      cogs: ['Підрядники на проєкти', 'Ліцензії і матеріали для проєктів'],
      opex: ['Зарплати команди', 'Реклама і маркетинг', 'CRM і ПЗ', 'Зв\'язок', 'Оренда офісу / коворкінг'],
      taxes: ['Єдиний податок', 'ЄСВ', 'Банківське обслуговування'],
      always_present: [
        { name: 'Виплата власнику', cost_type: 'owner' },
        { name: 'Мобільний зв\'язок', cost_type: 'opex' },
        { name: 'Підписки на ПЗ', cost_type: 'opex' },
        { name: 'Банківські комісії', cost_type: 'tax' },
      ],
    },
    торгівля: {
      income: ['Продаж товарів (роздріб)', 'Продаж товарів (опт)', 'Доставка (якщо платна)'],
      cogs: ['Закупівля товару', 'Логістика і доставка', 'Митні платежі', 'Складські витрати'],
      opex: ['Зарплати команди', 'Оренда точки / складу', 'Реклама і маркетинг', 'Еквайринг', 'Пакування і матеріали'],
      taxes: ['Єдиний податок / ПДВ', 'ЄСВ', 'Банківське обслуговування'],
      always_present: [
        { name: 'Виплата власнику', cost_type: 'owner' },
        { name: 'Мобільний зв\'язок', cost_type: 'opex' },
        { name: 'Підписки на ПЗ', cost_type: 'opex' },
        { name: 'Банківські комісії', cost_type: 'tax' },
      ],
    },
    виробництво: {
      income: ['Продаж продукції', 'Оптові замовлення', 'Виробництво на замовлення'],
      cogs: ['Сировина і матеріали', 'Пакування', 'Логістика і доставка', 'Виробничі комунальні'],
      opex: ['Зарплати офісу і управління', 'Оренда виробництва', 'Обслуговування обладнання'],
      taxes: ['Податок на прибуток / єдиний податок', 'ЄСВ', 'Банківське обслуговування'],
      always_present: [
        { name: 'Виплата власнику', cost_type: 'owner' },
        { name: 'Мобільний зв\'язок', cost_type: 'opex' },
        { name: 'Підписки на ПЗ', cost_type: 'opex' },
        { name: 'Банківські комісії', cost_type: 'tax' },
      ],
    },
  }

  return libraries[businessType] || libraries.послуги
}

function normalizeBusinessType(rawBusinessType) {
  const value = String(rawBusinessType || '').toLowerCase()
  if (/(вироб|цех|фабрик|майстерн)/.test(value)) return 'виробництво'
  if (/(торг|магаз|e-commerce|ecommerce|роздр|опт|товар)/.test(value)) return 'торгівля'
  return 'послуги'
}

function extractTeamRoles(processModel) {
  const lanes = Array.isArray(processModel?.lanes) ? processModel.lanes : []
  const roles = lanes
    .map((lane) => [lane.role, lane.responsible].filter(Boolean).join(' — '))
    .filter(Boolean)

  return roles.length > 0 ? roles.join(', ') : 'не вказано'
}

function buildCashflowFallbackQuestion(cashflowSession) {
  const completed = new Set(cashflowSession.completed_blocks || [])
  if (!completed.has('A')) return 'Я вже підготував базові джерела доходів. Що з цього у вас є, а що треба прибрати або додати?'
  if (!completed.has('B')) return 'Тепер зберемо прямі витрати під конкретні замовлення. Що з цього у вас виникає тільки коли є замовлення?'
  if (!completed.has('C')) return 'Тепер уточнимо витрати на команду. Які регулярні виплати людям у вас є?'
  if (!completed.has('D')) return 'Добре. Тепер пройдемося по витратах, які є щомісяця незалежно від кількості клієнтів. Що додамо?'
  if (!completed.has('E')) return 'Залишилося перевірити податки, банківські комісії та можливі кредити. Що з цього є у вас?'
  return 'Я зібрав основу для Cashflow і P&L. Перевірте, будь ласка, чи нічого не пропустили, і підтвердьте підсумок.'
}

function buildCashflowCompletionMessage(cashflowSession) {
  const byType = groupItemsByCostType(cashflowSession.items)
  const toLine = (title, list) => `${title}: ${list.length ? list.map((item) => item.name).join(', ') : '—'}`
  const lines = [
    'Вітаємо! Цей блок завершено. Ми зібрали основу для ваших майбутніх фінансових звітів.',
    '',
    'Нижче короткий підсумок структури P&L:',
    '',
    `💰 ${toLine('ДОХОДИ', byType.income)}`,
    `— ${toLine('Прямі витрати', byType.cogs)}`,
    '= ВАЛОВИЙ ПРИБУТОК',
    '',
    `— ${toLine('Витрати бізнесу', byType.opex)}`,
    '= ОПЕРАЦІЙНИЙ ПРИБУТОК',
    '',
    `— ${toLine('Виплата власнику', byType.owner)}`,
    '= ПРИБУТОК ДО ПОДАТКІВ',
    '',
    `— ${toLine('Податки', byType.tax)}`,
    '= ЧИСТИЙ ПРИБУТОК',
    '',
    `Всього зібрано ${cashflowSession.items_count} позицій.`,
    'Цей набір використовується одночасно для Cashflow і P&L, тому вам не потрібно заповнювати це повторно.',
    '',
    'Натисніть кнопку нижче і заберіть пакет документів:',
    '1) Статті Cashflow (з поясненнями)',
    '2) Статті P&L (з поясненнями)',
    '3) Інструкція по Cashflow',
    '4) Інструкція по P&L',
  ]
  return lines.join('\n')
}

function groupItemsByCostType(items) {
  const allItems = [
    ...(items.income || []),
    ...(items.cogs || []),
    ...(items.team || []),
    ...(items.operations || []),
    ...(items.taxes || []),
  ]

  return {
    income: allItems.filter((item) => item.cost_type === 'income'),
    cogs: allItems.filter((item) => item.cost_type === 'cogs'),
    opex: allItems.filter((item) => item.cost_type === 'opex'),
    owner: allItems.filter((item) => item.cost_type === 'owner'),
    tax: allItems.filter((item) => item.cost_type === 'tax'),
  }
}

// ─── Команди ─────────────────────────────────────────────────────────────────

bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const userId = msg.chat.id
  const payload = normalizeScenario((match?.[1] || '').trim().toLowerCase())
  await launchScenario(userId, payload)
})

bot.onText(/\/restart/, async (msg) => {
  const userId = msg.chat.id
  const session = await db.getOrCreateSession(userId)
  await launchScenario(userId, session.current_scenario || SCENARIO_MAIN)
})

bot.onText(/\/status/, async (msg) => {
  const userId = msg.chat.id
  try {
    const session = await db.getOrCreateSession(userId)
    const status = session.status === 'complete' ? '✅ Завершено' : '🔄 В процесі'
    if (session.current_scenario === SCENARIO_CASHFLOW) {
      const cashflowSession = normalizeCashflowSession(session.cashflow_session)
      await safeSendMessage(userId,
        `📋 Статус вашої сесії:\n• Режим: статті для Cashflow + P&L\n• Статус: ${status}\n• Зібрано позицій: ${cashflowSession.items_count}\n• Завершено блоків: ${cashflowSession.completed_blocks.length}/5`
      )
      return
    }

    if (session.current_scenario === SCENARIO_FINANCIAL_MECHANICS) {
      const financialSession = normalizeFinancialMechanicsSession(session.financial_mechanics_session)
      await safeSendMessage(userId,
        `📋 Статус вашої сесії:\n• Режим: діагностика фінансової механіки\n• Статус: ${status}\n• Поточний блок: ${financialSession.current_block}\n• Завершено блоків: ${financialSession.completed_blocks.length}`
      )
      return
    }

    const lanes = session.process_model?.lanes?.length || 0
    const nodes = (session.process_model?.lanes || []).reduce((s, l) => s + (l.nodes?.length || 0), 0)
    await safeSendMessage(userId,
      `📋 Статус вашої сесії:\n• Режим: опис бізнес-процесу\n• Статус: ${status}\n• Ролей (swimlanes): ${lanes}\n• Кроків (вузлів): ${nodes}\n• Блок: ${session.current_block}/5`
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
    const session = await db.getOrCreateSession(userId)
    if (isFinancialMechanicsTrigger(text) && session.current_scenario !== SCENARIO_FINANCIAL_MECHANICS) {
      await launchScenario(userId, SCENARIO_FINANCIAL_MECHANICS)
      return
    }
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
      const session = await db.getOrCreateSession(userId)
      await launchScenario(userId, session.current_scenario || SCENARIO_MAIN)
    } else if (action === 'action_financial_update') {
      await bot.answerCallbackQuery(query.id, { text: 'Оновлюємо діагностику...' })
      const session = await db.getOrCreateSession(userId)
      const nextSession = await db.resetSessionForScenario(userId, SCENARIO_FINANCIAL_MECHANICS)
      const financialSession = normalizeFinancialMechanicsSession(nextSession.financial_mechanics_session)
      financialSession.awaiting_context_files = !hasFinancialMechanicsContext(session, financialSession)
      nextSession.financial_mechanics_session = financialSession
      await db.saveSession(nextSession)

      if (financialSession.awaiting_context_files) {
        await safeSendMessage(userId, buildFinancialMechanicsContextRequestMessage())
      } else {
        await safeSendMessage(userId, buildFinancialMechanicsStartMessage(session.process_model))
      }
    } else if (action === 'action_financial_view') {
      const session = await db.getOrCreateSession(userId)
      if (session.financial_mechanics_model?.status === 'complete' && session.financial_mechanics_model?.markdown) {
        await bot.answerCallbackQuery(query.id, { text: 'Відправляю поточний файл...' })
        await sendFinancialMechanicsFile(userId, session)
      } else {
        await bot.answerCallbackQuery(query.id, { text: 'Файл ще не зібрано', show_alert: true })
      }
    } else if (action === 'action_download' || action === 'action_download_process' || action === 'action_download_cashflow' || action === 'action_download_financial') {
      console.log(`[bot] User ${userId}: Clicked download button`)
      const session = await db.getOrCreateSession(userId)
      if (action === 'action_download_cashflow') {
        const cashflowSession = normalizeCashflowSession(session.cashflow_session)
        if (cashflowSession.items_count > 0) {
          await bot.answerCallbackQuery(query.id, { text: '📑 Готово...' })
          await sendCashflowFiles(userId, session)
        } else {
          await bot.answerCallbackQuery(query.id, { text: '❌ Cashflow ще не готовий', show_alert: true })
        }
      } else if (action === 'action_download_process') {
        if (session.mermaid_code && session.process_model?.mermaid_code) {
          await bot.answerCallbackQuery(query.id, { text: '📑 Готово...' })
          await sendProcessFiles(userId, session)
        } else {
          await bot.answerCallbackQuery(query.id, { text: '❌ Схема ще не готова', show_alert: true })
        }
      } else if (action === 'action_download_financial') {
        if (session.financial_mechanics_model?.status === 'complete' && session.financial_mechanics_model?.markdown) {
          await bot.answerCallbackQuery(query.id, { text: '📑 Готово...' })
          await sendFinancialMechanicsFile(userId, session)
        } else {
          await bot.answerCallbackQuery(query.id, { text: '❌ Діагностика ще не завершена', show_alert: true })
        }
      } else if (session.current_scenario === SCENARIO_CASHFLOW && session.cashflow_session?.items_count > 0) {
        await bot.answerCallbackQuery(query.id, { text: '📑 Готово...' })
        await sendCashflowFiles(userId, session)
      } else if (session.mermaid_code && session.process_model?.mermaid_code) {
        await bot.answerCallbackQuery(query.id, { text: '📑 Готово...' })
        await sendProcessFiles(userId, session)
      } else {
        await bot.answerCallbackQuery(query.id, { text: '❌ Файл ще не готовий', show_alert: true })
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
  const caption = msg.caption || ''
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

    const importedFinancialContext = await tryImportFinancialMechanicsContextDocument(userId, fileBuffer, fileName, mimeType, caption)
    if (importedFinancialContext) {
      return
    }

    const importedProcessModel = await tryImportProcessModelFromDocument(userId, fileBuffer, fileName, mimeType)
    if (importedProcessModel) {
      return
    }

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

async function sendCompletionActions(userId, scenario = SCENARIO_MAIN) {
  const isCashflow = scenario === SCENARIO_CASHFLOW
  const isFinancial = scenario === SCENARIO_FINANCIAL_MECHANICS
  const text = isCashflow
    ? 'Готово. Блок зі статтями завершено, можете забрати ваш пакет документів:'
    : isFinancial
      ? 'Готово. Діагностика фінансової механіки завершена, можете забрати файл:'
      : `${MAIN_COMPLETION_MESSAGE}\n\nОберіть дію нижче:`
  const downloadLabel = isCashflow
    ? 'Забрати мої документи'
    : isFinancial
      ? 'Отримати financial_mechanics.md'
      : 'Отримати опис процесу'
  const downloadAction = isCashflow
    ? 'action_download_cashflow'
    : isFinancial
      ? 'action_download_financial'
      : 'action_download_process'
  try {
    await bot.sendMessage(userId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Повернутись і відредагувати ще щось', callback_data: 'action_restart' },
            { text: downloadLabel, callback_data: downloadAction },
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
            { text: downloadLabel, callback_data: downloadAction },
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

async function sendCashflowFiles(userId, session) {
  const cashflowSession = normalizeCashflowSession(session.cashflow_session)

  const cashflowDoc = buildCashflowArticlesDocument(session, cashflowSession)
  const plDoc = buildPLArticlesDocument(session, cashflowSession)

  const cashflowDocBuffer = Buffer.from(cashflowDoc, 'utf8')
  const plDocBuffer = Buffer.from(plDoc, 'utf8')

  await sendChatAction(userId, 'upload_document')
  await bot.sendDocument(
    userId,
    cashflowDocBuffer,
    { caption: 'Файл 1/4: статті Cashflow з поясненнями' },
    { filename: 'cashflow_articles.txt', contentType: 'text/plain' }
  )

  await sendChatAction(userId, 'upload_document')
  await bot.sendDocument(
    userId,
    plDocBuffer,
    { caption: 'Файл 2/4: статті P&L з поясненнями' },
    { filename: 'pl_articles.txt', contentType: 'text/plain' }
  )

  await sendInstructionDocs(userId)
}

async function sendFinancialMechanicsFile(userId, session) {
  const markdown = session.financial_mechanics_model?.markdown || ''
  if (!markdown.trim()) {
    await safeSendMessage(userId, 'Файл financial_mechanics.md ще не зібрано.')
    return
  }

  const docBuffer = Buffer.from(markdown, 'utf8')
  await sendChatAction(userId, 'upload_document')
  await bot.sendDocument(
    userId,
    docBuffer,
    { caption: 'Файл: financial_mechanics.md' },
    { filename: 'financial_mechanics.md', contentType: 'text/markdown' }
  )
}

async function sendInstructionDocs(userId) {
  const docs = [
    {
      path: CASHFLOW_INSTRUCTION_DOC_PATH,
      caption: 'Файл 3/4: інструкція Cashflow',
    },
    {
      path: PL_INSTRUCTION_DOC_PATH,
      caption: 'Файл 4/4: інструкція P&L',
    },
  ]

  for (const doc of docs) {
    if (!fs.existsSync(doc.path)) {
      console.warn(`[bot] Instruction file not found: ${doc.path}`)
      await safeSendMessage(userId, `Не знайшов один з інструкційних файлів: ${path.basename(doc.path)}`)
      continue
    }

    await sendChatAction(userId, 'upload_document')
    await bot.sendDocument(userId, doc.path, { caption: doc.caption })
  }
}

function buildCashflowArticlesDocument(session, cashflowSession) {
  const businessType = session.process_model?.business_type || 'не вказано'
  const blocks = []
  blocks.push('# Статті Cashflow')
  blocks.push('')
  blocks.push('Цей документ містить фінансові статті для Cashflow-звіту.')
  blocks.push('У Cashflow ці статті використовуються для планування і контролю руху грошей по періодах (місяць/квартал).')
  blocks.push('')
  blocks.push(`Тип бізнесу: ${businessType}`)
  blocks.push(`Всього позицій: ${cashflowSession.items_count}`)
  blocks.push('')
  blocks.push('## Доходи')
  blocks.push(...formatItemsForDocument(cashflowSession.items.income || []))
  blocks.push('')
  blocks.push('## Прямі витрати під замовлення')
  blocks.push(...formatItemsForDocument(cashflowSession.items.cogs || []))
  blocks.push('')
  blocks.push('## Витрати на команду')
  blocks.push(...formatItemsForDocument(cashflowSession.items.team || []))
  blocks.push('')
  blocks.push('## Операційні витрати')
  blocks.push(...formatItemsForDocument(cashflowSession.items.operations || []))
  blocks.push('')
  blocks.push('## Податки і фінансові витрати')
  blocks.push(...formatItemsForDocument(cashflowSession.items.taxes || []))
  blocks.push('')
  blocks.push('Пояснення: ці позиції будуть використані у вашій таблиці Cashflow, щоб бачити чистий грошовий результат у кожному періоді.')
  return blocks.join('\n')
}

function buildPLArticlesDocument(session, cashflowSession) {
  const businessType = session.process_model?.business_type || 'не вказано'
  const grouped = groupItemsByCostType(cashflowSession.items)

  const lines = []
  lines.push('# Статті P&L')
  lines.push('')
  lines.push('Цей документ містить ті самі позиції, але згруповані для P&L-звіту (звіт про прибуток і збитки).')
  lines.push('P&L показує, як формується прибуток: від доходу до чистого прибутку.')
  lines.push('')
  lines.push(`Тип бізнесу: ${businessType}`)
  lines.push(`Всього позицій: ${cashflowSession.items_count}`)
  lines.push('')
  lines.push('## 1. Доходи (Revenue)')
  lines.push(...formatItemsForDocument(grouped.income))
  lines.push('= Валовий дохід')
  lines.push('')
  lines.push('## 2. Прямі витрати (Cogs)')
  lines.push(...formatItemsForDocument(grouped.cogs))
  lines.push('= Валовий прибуток = Revenue - Cogs')
  lines.push('')
  lines.push('## 3. Операційні витрати (Opex)')
  lines.push(...formatItemsForDocument(grouped.opex))
  lines.push('= Операційний прибуток = Валовий прибуток - Opex')
  lines.push('')
  lines.push('## 4. Виплата власнику (Owner payout)')
  lines.push(...formatItemsForDocument(grouped.owner))
  lines.push('= Прибуток до податків = Операційний прибуток - Owner payout')
  lines.push('')
  lines.push('## 5. Податки (Taxes)')
  lines.push(...formatItemsForDocument(grouped.tax))
  lines.push('= Чистий прибуток = Прибуток до податків - Taxes')
  lines.push('')
  lines.push('Пояснення: ці групи використовуються у P&L, щоб бачити структуру прибутку та сильні/слабкі місця в економіці бізнесу.')
  return lines.join('\n')
}

function formatItemsForDocument(items) {
  if (!items || items.length === 0) {
    return ['- Немає позицій']
  }

  return items.map((item) => {
    const freq = formatFrequencyLabel(item.frequency)
    const regular = item.is_regular ? 'так' : 'ні'
    const notes = item.notes ? `; примітка: ${item.notes}` : ''
    return `- ${item.name} (частота: ${freq}; регулярна: ${regular}${notes})`
  })
}

function formatFrequencyLabel(value) {
  const dict = {
    monthly: 'щомісяця',
    quarterly: 'щокварталу',
    annual: 'раз на рік',
    project_based: 'під проєкт',
    irregular: 'нерегулярно',
  }

  return dict[value] || 'щомісяця'
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

function normalizeScenario(payload) {
  const value = String(payload || '').trim().toLowerCase()
  if (value === SCENARIO_CASHFLOW) return SCENARIO_CASHFLOW
  if (value === SCENARIO_FINANCIAL_MECHANICS || value === 'lesson_3_3_diagnosis') return SCENARIO_FINANCIAL_MECHANICS
  return SCENARIO_MAIN
}

function isFinancialMechanicsTrigger(text) {
  return isFinancialMechanicsTriggerFn(text)
}

function buildCashflowStartMessage(processModel) {
  const businessType = processModel?.business_type || 'ваш бізнес'
  const teamSize = processModel?.team_size || 0
  return `Вітаємо! Тут ми будемо працювати над статтями для ваших майбутніх звітів.

Тепер зберемо всі доходи і витрати.

Я вже знаю, що у вас ${businessType} і команда ${teamSize} ${pluralizePeople(teamSize)}.
Буду пропонувати готові варіанти, а ви підтвердите або підкоригуєте.

Важливий момент: ці дані ми збираємо один раз, і вони підуть і в Cashflow, і в P&L.
Тому для частини витрат уточню одне просте питання.

Займе 7-10 хвилин. Поїхали?

Почнемо. Які з базових джерел доходу у вас точно є?`
}

function pluralizePeople(count) {
  if (count % 10 === 1 && count % 100 !== 11) return 'людина'
  if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) return 'людини'
  return 'людей'
}

async function launchScenario(userId, payload) {
  const requestedScenario = normalizeScenario(payload)
  const session = await db.getOrCreateSession(userId)

  // Відправляємо профіль-фото без підпису
  try {
    await bot.sendPhoto(userId, PROFILE_PHOTO_PATH)
  } catch (err) {
    console.warn('[bot] Failed to send profile photo:', err.message)
  }

  if (requestedScenario === SCENARIO_CASHFLOW) {
    if (!hasCompletedProcessModel(session.process_model)) {
      const nextSession = await db.resetSessionForScenario(userId, SCENARIO_CASHFLOW)
      const nextCashflowSession = normalizeCashflowSession(nextSession.cashflow_session)
      nextCashflowSession.awaiting_process_model_file = true
      nextSession.cashflow_session = nextCashflowSession
      await db.saveSession(nextSession)

      await safeSendMessage(userId, `Щоб перейти до статей звітів, потрібен ваш файл бізнес-процесу.

Якщо ви вже заповнювали його в іншому чаті, надішліть сюди файл process_model.json.
Після імпорту одразу продовжимо без повторних питань.`)
      return
    }

    const nextSession = await db.resetSessionForScenario(userId, SCENARIO_CASHFLOW)
    const nextCashflowSession = normalizeCashflowSession(nextSession.cashflow_session)
    nextCashflowSession.awaiting_process_model_file = false
    nextSession.cashflow_session = nextCashflowSession
    await db.saveSession(nextSession)
    await safeSendMessage(userId, buildCashflowStartMessage(session.process_model))
    return
  }

  if (requestedScenario === SCENARIO_FINANCIAL_MECHANICS) {
    const financialSession = normalizeFinancialMechanicsSession(session.financial_mechanics_session)
    const alreadyBuilt = session.financial_mechanics_model?.status === 'complete' && session.financial_mechanics_model?.markdown

    if (alreadyBuilt) {
      const lastDate = session.financial_mechanics_model?.diagnosis_date
        ? new Date(session.financial_mechanics_model.diagnosis_date).toISOString().slice(0, 10)
        : 'невідома дата'

      await bot.sendMessage(userId, `У мене вже є діагностика фінансової механіки твого бізнесу від ${lastDate}.

Хочеш оновити її чи переглянути поточну?`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Оновити', callback_data: 'action_financial_update' },
              { text: 'Переглянути поточну', callback_data: 'action_financial_view' },
            ],
          ],
        },
      })
      return
    }

    const nextSession = await db.resetSessionForScenario(userId, SCENARIO_FINANCIAL_MECHANICS)
    const nextFinancialSession = normalizeFinancialMechanicsSession(nextSession.financial_mechanics_session)
    const hasContext = hasFinancialMechanicsContext(session, nextFinancialSession)
    nextFinancialSession.awaiting_context_files = !hasContext
    nextSession.financial_mechanics_session = nextFinancialSession
    nextSession.current_scenario = SCENARIO_FINANCIAL_MECHANICS
    await db.saveSession(nextSession)

    if (!hasContext) {
      await safeSendMessage(userId, buildFinancialMechanicsContextRequestMessage())
      return
    }

    await safeSendMessage(userId, buildFinancialMechanicsStartMessage(session.process_model))
    return
  }

  await db.resetSessionForScenario(userId, SCENARIO_MAIN)
  await safeSendMessage(userId, MAIN_START_MESSAGE)
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

async function tryImportFinancialMechanicsContextDocument(userId, fileBuffer, fileName, mimeType, caption = '') {
  const session = await db.getOrCreateSession(userId)
  const financialSession = normalizeFinancialMechanicsSession(session.financial_mechanics_session)
  const lowerName = String(fileName || '').toLowerCase()
  const diagnosisRequested = isFinancialMechanicsTrigger(caption)
  const inFinancialFlow = session.current_scenario === SCENARIO_FINANCIAL_MECHANICS || financialSession.awaiting_context_files || diagnosisRequested

  if (!inFinancialFlow) {
    return false
  }

  let changed = false

  if (/(business_process|process_model).*\.json$/i.test(lowerName) || lowerName === 'business_process.json') {
    const text = decodeTextBuffer(fileBuffer).trim()
    if (text) {
      try {
        const parsed = JSON.parse(text)
        const model = (parsed && typeof parsed === 'object' && parsed.process_model) ? parsed.process_model : parsed
        if (isProcessModelShape(model)) {
          session.process_model = { ...model, status: 'complete' }
          financialSession.imported_documents.business_process_raw = text.slice(0, 20000)
          changed = true
          await safeSendMessage(userId, '✅ business_process.json отримано і збережено.')
        }
      } catch {
        // ignore invalid JSON and continue with regular flow
      }
    }
  }

  const isArticlesFile = /(pl[_\- ]?articles|cashflow[_\- ]?articles)/i.test(lowerName) || lowerName.endsWith('.md') || lowerName.endsWith('.txt')
  if (isArticlesFile) {
    const extractedText = await extractTextFromDocument(fileBuffer, fileName, mimeType)
    if (String(extractedText || '').trim()) {
      if (/pl[_\- ]?articles/i.test(lowerName)) {
        financialSession.imported_documents.pl_articles = extractedText.slice(0, 50000)
        changed = true
        await safeSendMessage(userId, '✅ pl_articles отримано і збережено.')
      } else if (/cashflow[_\- ]?articles/i.test(lowerName) || diagnosisRequested) {
        financialSession.imported_documents.cashflow_articles = extractedText.slice(0, 50000)
        changed = true
        await safeSendMessage(userId, '✅ cashflow_articles отримано і збережено.')
      }
    }
  }

  if (!changed) {
    return false
  }

  session.current_scenario = SCENARIO_FINANCIAL_MECHANICS
  session.financial_mechanics_session = financialSession
  financialSession.awaiting_context_files = !hasFinancialMechanicsContext(session, financialSession)
  session.status = 'draft'
  await db.saveSession(session)

  if (financialSession.awaiting_context_files) {
    await safeSendMessage(userId, 'Ще потрібні обидва файли: cashflow_articles.md і business_process.json. Коли отримаю їх, одразу стартуємо діагностику.')
  } else {
    await safeSendMessage(userId, buildFinancialMechanicsStartMessage(session.process_model))
  }

  return true
}

async function tryImportProcessModelFromDocument(userId, fileBuffer, fileName, mimeType) {
  const ext = path.extname(fileName || '').toLowerCase()
  const isJsonLike = ext === '.json' || mimeType === 'application/json' || /process_model/i.test(fileName || '')
  if (!isJsonLike) {
    return false
  }

  const text = decodeTextBuffer(fileBuffer).trim()
  if (!text) {
    return false
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }

  const model = (parsed && typeof parsed === 'object' && parsed.process_model) ? parsed.process_model : parsed
  if (!isProcessModelShape(model)) {
    return false
  }

  const session = await db.getOrCreateSession(userId)
  const normalizedModel = {
    ...model,
    status: 'complete',
  }

  session.process_model = normalizedModel
  session.current_scenario = SCENARIO_CASHFLOW
  session.status = 'draft'
  if (typeof normalizedModel.mermaid_code === 'string' && normalizedModel.mermaid_code.trim()) {
    session.mermaid_code = normalizedModel.mermaid_code
  }

  const cashflowSession = normalizeCashflowSession(session.cashflow_session)
  cashflowSession.awaiting_process_model_file = false
  session.cashflow_session = cashflowSession

  await db.saveSession(session)

  await safeSendMessage(userId, 'Дякую, файл бізнес-процесу отримано. Закріпив його за вашим профілем і продовжую роботу над статтями для звітів.')
  await safeSendMessage(userId, buildCashflowStartMessage(normalizedModel))
  return true
}

function isProcessModelShape(value) {
  if (!value || typeof value !== 'object') return false
  return Array.isArray(value.lanes) && Array.isArray(value.edges)
}

function hasCompletedProcessModel(processModel) {
  return Boolean(processModel && processModel.status === 'complete' && Array.isArray(processModel.lanes))
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
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))

        // Deduplicate: if this update was already processed, skip it.
        const updateId = update.update_id
        if (updateId && processedUpdateIds.has(updateId)) {
          console.warn(`[bot] Duplicate update_id=${updateId} ignored`)
          return
        }
        if (updateId) {
          processedUpdateIds.add(updateId)
          // Keep set bounded to last 200 IDs
          if (processedUpdateIds.size > 200) {
            processedUpdateIds.delete(processedUpdateIds.values().next().value)
          }
        }

        // Process update asynchronously so Telegram webhook call is acknowledged quickly.
        Promise.resolve()
          .then(() => bot.processUpdate(update))
          .catch((err) => {
            console.error('[bot] Async processUpdate error:', err.message)
          })
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
  httpServer = startHttpServer()
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

async function shutdown(signal) {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`[bot] Received ${signal}. Starting graceful shutdown...`)

  try {
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve))
      console.log('[bot] HTTP server closed')
    }
    await db.close()
    console.log('[bot] Graceful shutdown completed')
    process.exit(0)
  } catch (err) {
    console.error('[bot] Graceful shutdown failed:', err.message)
    process.exit(1)
  }
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM')
})

process.on('SIGINT', () => {
  shutdown('SIGINT')
})
