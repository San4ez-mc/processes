'use strict'
const config = require('./config')

let _anthropicClient = null
let _openaiClient = null

function getAnthropicClient() {
  if (!_anthropicClient) {
    const Anthropic = require('@anthropic-ai/sdk')
    _anthropicClient = new Anthropic({ apiKey: config.llm.anthropicApiKey })
  }
  return _anthropicClient
}

function getOpenAIClient() {
  if (!_openaiClient) {
    const OpenAI = require('openai')
    _openaiClient = new OpenAI({ apiKey: config.llm.openaiApiKey })
  }
  return _openaiClient
}

/**
 * Виклик LLM API
 * @param {object} params
 * @param {string} params.system - системний промпт
 * @param {Array<{role: string, content: string}>} params.messages - історія повідомлень
 * @returns {Promise<string>} відповідь моделі
 */
async function callLLM({ system, messages }) {
  if (config.llm.provider === 'anthropic') {
    return callAnthropic({ system, messages })
  }
  return callOpenAI({ system, messages })
}

async function callAnthropic({ system, messages }) {
  const client = getAnthropicClient()
  const response = await client.messages.create({
    model: config.llm.model,
    max_tokens: config.llm.maxTokens,
    system,
    messages,
  })
  return response.content[0].text
}

async function callOpenAI({ system, messages }) {
  const client = getOpenAIClient()
  const completion = await client.chat.completions.create({
    model: config.llm.model,
    max_tokens: config.llm.maxTokens,
    messages: [{ role: 'system', content: system }, ...messages],
  })
  return completion.choices[0].message.content
}

module.exports = { callLLM }
