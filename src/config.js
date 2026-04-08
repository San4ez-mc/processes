'use strict'
require('dotenv').config()

const required = ['TELEGRAM_BOT_TOKEN', 'DATABASE_URL']
const missing = required.filter((key) => !process.env[key])
if (missing.length > 0) {
  console.error(`[config] Відсутні обов'язкові змінні середовища: ${missing.join(', ')}`)
  process.exit(1)
}

const provider = process.env.LLM_PROVIDER || 'anthropic'
if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
  console.error('[config] ANTHROPIC_API_KEY не задано (LLM_PROVIDER=anthropic)')
  process.exit(1)
}
if (provider === 'openai' && !process.env.OPENAI_API_KEY) {
  console.error('[config] OPENAI_API_KEY не задано (LLM_PROVIDER=openai)')
  process.exit(1)
}

module.exports = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
  },
  llm: {
    provider,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    model: process.env.LLM_MODEL || (provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o'),
    maxTokens: 2048,
  },
  db: {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' && process.env.DB_SSL !== 'false'
      ? { rejectUnauthorized: false }
      : false,
  },
  mermaid: {
    width: 1200,
    backgroundColor: 'white',
    tmpDir: process.env.MERMAID_TMP_DIR || '/tmp/mermaid',
  },
}
