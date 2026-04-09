'use strict'
require('dotenv').config()

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

function resolveWebhookBaseUrl() {
  const explicitUrl = normalizeBaseUrl(process.env.TELEGRAM_WEBHOOK_URL)
  if (explicitUrl) return explicitUrl

  const railwayDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim()
  if (railwayDomain) {
    return `https://${railwayDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
  }

  const railwayStaticUrl = normalizeBaseUrl(process.env.RAILWAY_STATIC_URL)
  if (railwayStaticUrl) return railwayStaticUrl

  return ''
}

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

const dbSslEnabled = (process.env.DB_SSL || 'false').toLowerCase() === 'true'
const webhookBaseUrl = resolveWebhookBaseUrl()
const webhookPath = process.env.TELEGRAM_WEBHOOK_PATH || `/telegram/webhook/${process.env.TELEGRAM_WEBHOOK_SECRET || 'business-process-agent'}`
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || ''

module.exports = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    webhookBaseUrl,
    webhookPath,
    webhookSecret,
  },
  llm: {
    provider,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    model: process.env.LLM_MODEL || (provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o'),
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 4096),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 90000),
  },
  db: {
    connectionString: process.env.DATABASE_URL,
    ssl: dbSslEnabled ? { rejectUnauthorized: false } : false,
  },
  mermaid: {
    width: 1200,
    backgroundColor: 'white',
    tmpDir: process.env.MERMAID_TMP_DIR || '/tmp/mermaid',
  },
}
