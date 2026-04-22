'use strict'
const { callLLM } = require('./llm')
const {
  INTERVIEW_PROMPT,
  VALIDATOR_PROMPT,
  MERMAID_PROMPT,
  CASHFLOW_PROMPT,
  FINANCIAL_MECHANICS_PROMPT,
} = require('./prompts')

/**
 * Витягти JSON process_model з відповіді агента
 * Agentвідповідь має містити блок: <process_model>...</process_model>
 * @param {string} text
 * @returns {object|null}
 */
function extractProcessModel(text) {
  return extractTaggedJson(text, 'process_model')
}

function extractCashflowSession(text) {
  return extractTaggedJson(text, 'cashflow_session')
}

function extractFinancialMechanicsSession(text) {
  return extractTaggedJson(text, 'financial_mechanics_session')
}

function extractTaggedJson(text, tagName) {
  const strictMatch = text.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\/${tagName}>`, 'i'))
  if (strictMatch) {
    try {
      return JSON.parse(strictMatch[1].trim())
    } catch {
      // fall through to tolerant parsing below
    }
  }

  // Tolerant mode: model block may be truncated and miss closing tag.
  const openTag = `<${tagName}>`
  const openIdx = text.toLowerCase().indexOf(openTag)
  if (openIdx < 0) return null

  const afterOpen = text.slice(openIdx + openTag.length)
  const startJson = afterOpen.indexOf('{')
  if (startJson < 0) return null

  const jsonChunk = afterOpen.slice(startJson)
  const balanced = extractBalancedJsonObject(jsonChunk)
  if (!balanced) return null

  try {
    return JSON.parse(balanced)
  } catch {
    return null
  }
}

/**
 * Витягти текст для відображення клієнту (без JSON-блоку і маркерів)
 * @param {string} text
 * @returns {string}
 */
function extractBotText(text) {
  return extractBotTextWithoutTag(text, 'process_model')
}

function extractCashflowText(text) {
  return extractBotTextWithoutTag(text, 'cashflow_session')
}

function extractFinancialMechanicsText(text) {
  return extractBotTextWithoutTag(text, 'financial_mechanics_session')
}

function extractBotTextWithoutTag(text, tagName) {
  const openTagRegex = new RegExp(`<${tagName}>`, 'i')
  const closeTagRegex = new RegExp(`<\/${tagName}>`, 'i')
  let sanitized = text

  sanitized = sanitized.replace(new RegExp(`<${tagName}>[\\s\\S]*?<\/${tagName}>`, 'gi'), '')

  if (openTagRegex.test(sanitized) && !closeTagRegex.test(sanitized)) {
    sanitized = sanitized.replace(new RegExp(`<${tagName}>[\\s\\S]*`, 'i'), '')
  }

  return sanitized
    .replace(/###INTERVIEW_COMPLETE###/g, '')
    .replace(/###CASHFLOW_ITEMS_COMPLETE###/g, '')
    .replace(/```json\s*[\s\S]*?```/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim()
}

function extractBalancedJsonObject(input) {
  let depth = 0
  let inString = false
  let escaped = false
  let started = false

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]

    if (!started) {
      if (ch === '{') {
        started = true
        depth = 1
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === '{') depth += 1
    if (ch === '}') depth -= 1

    if (depth === 0) {
      const start = input.indexOf('{')
      return input.slice(start, i + 1)
    }
  }

  return ''
}

/**
 * Компонент 1 — Інтерв'ю-агент
 * Веде один крок діалогу, повертає оновлену модель і текст для клієнта
 * @param {object} session
 * @returns {Promise<{updatedModel: object|null, text: string, isComplete: boolean}>}
 */
async function runInterviewStep(session) {
  const systemPrompt = INTERVIEW_PROMPT
    .replace('{{process_model_json}}', JSON.stringify(session.process_model, null, 2))
    .replace('{{current_block}}', String(session.current_block))
    .replace('{{completed_blocks}}', session.completed_blocks.join(', ') || 'жоден')

  const response = await callLLM({
    system: systemPrompt,
    messages: session.history,
  })

  const updatedModel = extractProcessModel(response)
  const text = extractBotText(response)
  const isComplete = response.includes('###INTERVIEW_COMPLETE###')

  return { updatedModel, text, isComplete }
}

async function runCashflowInterviewStep({ processModel, cashflowSession, history, itemsLibrary, teamRoles }) {
  const systemPrompt = CASHFLOW_PROMPT
    .replace('{{business_type}}', processModel?.business_type || 'невідомий тип бізнесу')
    .replace('{{team_size}}', String(processModel?.team_size || 0))
    .replace('{{team_roles}}', teamRoles || 'не вказано')
    .replace('{{items_library}}', JSON.stringify(itemsLibrary, null, 2))
    .replace('{{completed_blocks}}', (cashflowSession?.completed_blocks || []).join(', ') || 'жоден')
    .replace('{{collected_items}}', JSON.stringify(cashflowSession?.items || {}, null, 2))

  const response = await callLLM({
    system: systemPrompt,
    messages: history,
  })

  const updatedSession = extractCashflowSession(response)
  const text = extractCashflowText(response)
  const isComplete = response.includes('###CASHFLOW_ITEMS_COMPLETE###')

  return { updatedSession, text, isComplete }
}

async function runFinancialMechanicsInterviewStep({ processModel, cashflowSession, financialMechanicsSession, history, plArticlesContext }) {
  const systemPrompt = FINANCIAL_MECHANICS_PROMPT
    .replace('{{business_process_context}}', JSON.stringify(processModel || {}, null, 2))
    .replace('{{pl_articles_context}}', plArticlesContext || JSON.stringify(cashflowSession?.items || {}, null, 2))
    .replace('{{financial_mechanics_session_json}}', JSON.stringify(financialMechanicsSession || {}, null, 2))

  const response = await callLLM({
    system: systemPrompt,
    messages: history,
  })

  const updatedSession = extractFinancialMechanicsSession(response)
  const text = extractFinancialMechanicsText(response)
  const isComplete = response.includes('###FINANCIAL_MECHANICS_COMPLETE###')

  return { updatedSession, text, isComplete }
}

/**
 * Компонент 2 — Валідатор логіки
 * Перевіряє JSON-модель на повноту і логіку
 * @param {object} processModel
 * @returns {Promise<{valid: boolean, errors: Array}>}
 */
async function runValidator(processModel) {
  const response = await callLLM({
    system: VALIDATOR_PROMPT,
    messages: [
      { role: 'user', content: JSON.stringify(processModel, null, 2) },
    ],
  })

  // Прибираємо можливу markdown-обгортку
  const clean = response
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim()

  try {
    return JSON.parse(clean)
  } catch {
    // Якщо парсинг не вдався — вважаємо валідним щоб не блокувати
    console.warn('[validator] Could not parse validation response, assuming valid')
    return { valid: true, errors: [] }
  }
}

/**
 * Компонент 3 — Mermaid-генератор
 * Генерує Mermaid flowchart код на основі validated process_model
 * @param {object} processModel
 * @returns {Promise<string>} Mermaid-код
 */
async function runMermaidGenerator(processModel) {
  const response = await callLLM({
    system: MERMAID_PROMPT,
    messages: [
      { role: 'user', content: JSON.stringify(processModel, null, 2) },
    ],
  })

  // Прибираємо можливу markdown-обгортку ```mermaid ... ```
  const clean = response
    .replace(/```mermaid\s*/g, '')
    .replace(/```\s*/g, '')
    .trim()

  return clean
}

module.exports = {
  runInterviewStep,
  runCashflowInterviewStep,
  runFinancialMechanicsInterviewStep,
  runValidator,
  runMermaidGenerator,
}
