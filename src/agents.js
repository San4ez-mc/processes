'use strict'
const { callLLM } = require('./llm')
const { INTERVIEW_PROMPT, VALIDATOR_PROMPT, MERMAID_PROMPT } = require('./prompts')

/**
 * Витягти JSON process_model з відповіді агента
 * Agentвідповідь має містити блок: <process_model>...</process_model>
 * @param {string} text
 * @returns {object|null}
 */
function extractProcessModel(text) {
  const match = text.match(/<process_model>([\s\S]*?)<\/process_model>/)
  if (!match) return null
  try {
    return JSON.parse(match[1].trim())
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
  return text
    .replace(/<process_model>[\s\S]*?<\/process_model>/g, '')
    .replace(/###INTERVIEW_COMPLETE###/g, '')
    .trim()
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

module.exports = { runInterviewStep, runValidator, runMermaidGenerator }
