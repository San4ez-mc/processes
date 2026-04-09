'use strict'
const fs = require('fs')
const path = require('path')
const https = require('https')
const config = require('./config')

const forceApiRender = String(process.env.MERMAID_RENDER_MODE || '').toLowerCase() === 'api'
let localFailureLogged = false

/**
 * Рендеринг Mermaid-коду у PNG через mermaid-cli (локально)
 * Fallback: mermaid.ink API
 * @param {string} mermaidCode
 * @returns {Promise<Buffer>}
 */
async function renderMermaid(mermaidCode) {
  if (forceApiRender) {
    return await renderMermaidViaAPI(mermaidCode)
  }

  try {
    return await renderMermaidLocal(mermaidCode)
  } catch (err) {
    if (!localFailureLogged) {
      console.warn('[mermaid] Local render unavailable, switching to API fallback.')
      console.warn(`[mermaid] Reason: ${summarizeRenderError(err)}`)
      localFailureLogged = true
    }
    return await renderMermaidViaAPI(mermaidCode)
  }
}

function summarizeRenderError(err) {
  const message = String(err?.message || err || '').trim()
  const firstLine = message.split('\n')[0]
  return firstLine || 'unknown local render error'
}

/**
 * Локальний рендер через mermaid-cli + Puppeteer
 */
async function renderMermaidLocal(mermaidCode) {
  // Динамічний імпорт — mermaid-cli це ESM пакет
  const { run } = await import('@mermaid-js/mermaid-cli')

  const tmpDir = config.mermaid.tmpDir
  const inputFile = path.join(tmpDir, `diagram_${Date.now()}.mmd`)
  const outputFile = path.join(tmpDir, `diagram_${Date.now()}.png`)

  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(inputFile, mermaidCode, 'utf8')

  try {
    await run(inputFile, outputFile, {
      puppeteerConfig: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
      mermaidConfig: {
        theme: 'default',
        flowchart: { curve: 'basis' },
      },
      width: config.mermaid.width,
      backgroundColor: config.mermaid.backgroundColor,
    })

    const buffer = fs.readFileSync(outputFile)
    return buffer
  } finally {
    if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile)
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile)
  }
}

/**
 * Резервний рендер через публічний mermaid.ink API
 * Використовується якщо mermaid-cli недоступний
 */
async function renderMermaidViaAPI(mermaidCode) {
  // Кодуємо в base64 та URL-encoded
  const encoded = Buffer.from(mermaidCode, 'utf8').toString('base64url')
  const url = `https://mermaid.ink/img/${encoded}?width=${config.mermaid.width}&bgColor=white`

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Слідуємо редиректу
        https.get(res.headers.location, (res2) => collectBuffer(res2, resolve, reject))
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`mermaid.ink API returned ${res.statusCode}`))
        return
      }
      collectBuffer(res, resolve, reject)
    }).on('error', reject)
  })
}

function collectBuffer(res, resolve, reject) {
  const chunks = []
  res.on('data', (chunk) => chunks.push(chunk))
  res.on('end', () => resolve(Buffer.concat(chunks)))
  res.on('error', reject)
}

module.exports = { renderMermaid }
