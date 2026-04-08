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
       (telegram_id, process_model, history, status, validation_attempts, current_block, completed_blocks)
     VALUES ($1, $2, $3, 'draft', 0, 0, '[]')
     RETURNING *`,
    [telegramId, JSON.stringify(processModel), JSON.stringify([])]
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
       process_model       = $1,
       mermaid_code        = $2,
       history             = $3,
       status              = $4,
       validation_attempts = $5,
       current_block       = $6,
       completed_blocks    = $7
     WHERE telegram_id = $8`,
    [
      JSON.stringify(session.process_model),
      session.mermaid_code || null,
      JSON.stringify(session.history),
      session.status,
      session.validation_attempts,
      session.current_block,
      JSON.stringify(session.completed_blocks),
      session.telegram_id,
    ]
  )
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
 * Перевірити доступність БД і гарантовано створити таблицю sessions
 */
async function ensureReady() {
  try {
    await pool.query('SELECT 1')
    await runMigration()
    console.log('[db] Database is ready')
  } catch (err) {
    throw new Error(formatDbError(err))
  }
}

function rowToSession(row) {
  return {
    id: row.id,
    telegram_id: row.telegram_id,
    process_model: row.process_model,
    mermaid_code: row.mermaid_code,
    history: row.history,
    status: row.status,
    validation_attempts: row.validation_attempts,
    current_block: row.current_block,
    completed_blocks: row.completed_blocks,
  }
}

module.exports = {
  getOrCreateSession,
  saveSession,
  deleteSession,
  runMigration,
  ensureReady,
  formatDbError,
}
