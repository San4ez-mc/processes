'use strict'
const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')
const config = require('./config')

const pool = new Pool({
  connectionString: config.db.connectionString,
  ssl: config.db.ssl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', formatDbError(err))
})

function formatDbError(err) {
  if (!err) return 'Unknown DB error'
  const parts = []
  if (err.message) parts.push(err.message)
  if (err.code) parts.push(`code=${err.code}`)
  if (err.detail) parts.push(`detail=${err.detail}`)
  if (err.hint) parts.push(`hint=${err.hint}`)
  if (parts.length === 0) {
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return parts.join(' | ')
}

/**
 * Початковий стан process_model для нової сесії
 */
function makeInitialProcessModel(sessionId) {
  return {
    session_id: sessionId,
    business_type: '',
    team_size: 0,
    lanes: [],
    edges: [],
    status: 'draft',
    validation_errors: [],
    mermaid_code: '',
  }
}

function makeInitialCashflowSession() {
  return {
    items: {
      income: [],
      cogs: [],
      team: [],
      operations: [],
      taxes: [],
    },
    completed_blocks: [],
    history: [],
    items_count: 0,
    status: 'draft',
  }
}

/**
 * Отримати сесію або створити нову
 * @param {number} telegramId
 * @returns {Promise<object>} session
 */
async function getOrCreateSession(telegramId) {
  const { rows } = await pool.query(
    'SELECT * FROM sessions WHERE telegram_id = $1',
    [telegramId]
  )

  if (rows.length > 0) {
    return rowToSession(rows[0])
  }

  // Створюємо нову сесію
  const { v4: uuidv4 } = require('uuid')
  const sessionId = uuidv4()
  const processModel = makeInitialProcessModel(sessionId)

  const { rows: newRows } = await pool.query(
    `INSERT INTO sessions
       (telegram_id, current_scenario, process_model, cashflow_session, history, status, validation_attempts, current_block, completed_blocks)
     VALUES ($1, 'main_process', $2, $3, $4, 'draft', 0, 0, '[]')
     RETURNING *`,
    [telegramId, JSON.stringify(processModel), JSON.stringify(makeInitialCashflowSession()), JSON.stringify([])]
  )

  return rowToSession(newRows[0])
}

/**
 * Зберегти сесію
 * @param {object} session
 */
async function saveSession(session) {
  await pool.query(
    `UPDATE sessions SET
       current_scenario    = $1,
       process_model       = $2,
       cashflow_session    = $3,
       mermaid_code        = $4,
       history             = $5,
       status              = $6,
       validation_attempts = $7,
       current_block       = $8,
       completed_blocks    = $9
     WHERE telegram_id = $10`,
    [
      session.current_scenario || 'main_process',
      JSON.stringify(session.process_model),
      JSON.stringify(session.cashflow_session || makeInitialCashflowSession()),
      session.mermaid_code || null,
      JSON.stringify(session.history || []),
      session.status,
      session.validation_attempts,
      session.current_block,
      JSON.stringify(session.completed_blocks || []),
      session.telegram_id,
    ]
  )
}

function buildResetSession(session, scenario) {
  const next = {
    ...session,
    current_scenario: scenario,
    history: [],
    status: 'draft',
    validation_attempts: 0,
    current_block: 0,
    completed_blocks: [],
  }

  if (scenario === 'main_process') {
    const sessionId = session.process_model?.session_id || session.id
    next.process_model = makeInitialProcessModel(sessionId)
    next.cashflow_session = makeInitialCashflowSession()
    next.mermaid_code = null
  }

  if (scenario === 'cashflow_items') {
    next.cashflow_session = makeInitialCashflowSession()
  }

  return next
}

async function getSession(telegramId) {
  const { rows } = await pool.query(
    'SELECT * FROM sessions WHERE telegram_id = $1',
    [telegramId]
  )

  if (rows.length === 0) {
    return null
  }

  return rowToSession(rows[0])
}

async function resetSessionForScenario(telegramId, scenario) {
  const session = await getOrCreateSession(telegramId)
  const next = buildResetSession(session, scenario)
  await saveSession(next)
  return next
}

/**
 * Видалити сесію (для /restart)
 * @param {number} telegramId
 */
async function deleteSession(telegramId) {
  await pool.query('DELETE FROM sessions WHERE telegram_id = $1', [telegramId])
}

/**
 * Виконати SQL міграцію
 */
async function runMigration() {
  const migrationPath = path.join(__dirname, '..', 'migrations', '001_init.sql')
  const sql = fs.readFileSync(migrationPath, 'utf8')
  const client = await pool.connect()
  try {
    await client.query(sql)
    console.log('[db] Migration completed successfully')
  } finally {
    client.release()
  }
}

/**
 * Перевірити доступність БД і гарантовано створити таблицю sessions.
 * Повторює спроби з'єднання (Railway запускає Postgres паралельно з app).
 */
async function ensureReady({ retries = 8, delayMs = 4000 } = {}) {
  // Логуємо masked URL для діагностики (без пароля)
  const rawUrl = process.env.DATABASE_URL || ''
  const masked = rawUrl
    ? rawUrl.replace(/:[^:@]+@/, ':***@')
    : '(DATABASE_URL not set!)'
  console.log(`[db] Connecting to: ${masked}`)

  let lastErr
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query('SELECT 1')
      await runMigration()
      console.log('[db] Database is ready')
      return
    } catch (err) {
      lastErr = err
      console.warn(`[db] Attempt ${attempt}/${retries} failed: ${formatDbError(err)}`)
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
  }
  throw new Error(formatDbError(lastErr))
}

async function close() {
  try {
    await pool.end()
    console.log('[db] Pool closed')
  } catch (err) {
    console.error('[db] Pool close error:', formatDbError(err))
  }
}

function rowToSession(row) {
  return {
    id: row.id,
    telegram_id: row.telegram_id,
    current_scenario: row.current_scenario || 'main_process',
    process_model: row.process_model,
    cashflow_session: row.cashflow_session || makeInitialCashflowSession(),
    mermaid_code: row.mermaid_code,
    history: row.history,
    status: row.status,
    validation_attempts: row.validation_attempts,
    current_block: row.current_block,
    completed_blocks: row.completed_blocks,
  }
}

module.exports = {
  getSession,
  getOrCreateSession,
  saveSession,
  deleteSession,
  resetSessionForScenario,
  runMigration,
  ensureReady,
  close,
  formatDbError,
}
