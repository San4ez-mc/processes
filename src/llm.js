'use strict'
const config = require('./config')
const fs = require('fs')
const path = require('path')

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

function withTimeout(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timeout after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer)
  })
}

async function callAnthropic({ system, messages }) {
  const client = getAnthropicClient()
  const response = await withTimeout(client.messages.create({
    model: config.llm.model,
    max_tokens: config.llm.maxTokens,
    system,
    messages,
  }), config.llm.timeoutMs, 'Anthropic call')
  return response.content[0].text
}

async function callOpenAI({ system, messages }) {
  const client = getOpenAIClient()
  const completion = await withTimeout(client.chat.completions.create({
    model: config.llm.model,
    max_tokens: config.llm.maxTokens,
    messages: [{ role: 'system', content: system }, ...messages],
  }), config.llm.timeoutMs, 'OpenAI call')
  return completion.choices[0].message.content
}

/**
 * Транскрибувати аудіо через Whisper.
 * Потребує OPENAI_API_KEY незалежно від LLM_PROVIDER.
 * @param {Buffer} audioBuffer
 * @param {string} fileName
 * @returns {Promise<string>}
 */
async function transcribeAudio(audioBuffer, fileName = 'voice.ogg') {
  if (!config.llm.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required for voice transcription')
  }

  const client = getOpenAIClient()
  const tmpDir = '/tmp/voice'
  const tmpFile = path.join(tmpDir, `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9_.-]/g, '_')}`)

  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(tmpFile, audioBuffer)

  try {
    const response = await client.audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(tmpFile),
      language: 'uk',
    })
    return (response.text || '').trim()
  } finally {
    try {
      fs.unlinkSync(tmpFile)
    } catch {
      // ignore tmp cleanup issues
    }
  }
}

module.exports = { callLLM, transcribeAudio }
