'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeFinancialMechanicsSession,
  hasFinancialMechanicsContext,
  buildFinancialMechanicsFallbackQuestion,
  getMissingFinancialMechanicsSections,
  buildFinancialMechanicsDocument,
  isFinancialMechanicsTrigger,
} = require('../src/financialMechanics')

test('normalizeFinancialMechanicsSession fills defaults', () => {
  const normalized = normalizeFinancialMechanicsSession({})

  assert.equal(normalized.status, 'draft')
  assert.equal(normalized.current_block, 'A')
  assert.deepEqual(normalized.completed_blocks, [])
  assert.equal(normalized.skips.E, false)
  assert.equal(normalized.skips.F, false)
  assert.equal(normalized.recommended_pl_method, '')
})

test('isFinancialMechanicsTrigger detects diagnosis intent', () => {
  assert.equal(isFinancialMechanicsTrigger('пройди діагностику фінансової механіки'), true)
  assert.equal(isFinancialMechanicsTrigger('допоможи розібратись як рахувати P&L'), true)
  assert.equal(isFinancialMechanicsTrigger('просто привіт'), false)
})

test('hasFinancialMechanicsContext requires completed process and either cashflow or imported docs', () => {
  const baseSession = {
    process_model: { status: 'complete', lanes: [] },
    cashflow_session: { items: { income: [], cogs: [], team: [], operations: [], taxes: [] } },
  }

  const financialEmpty = normalizeFinancialMechanicsSession({ imported_documents: {} })
  assert.equal(hasFinancialMechanicsContext(baseSession, financialEmpty), false)

  const withCashflow = {
    ...baseSession,
    cashflow_session: { items: { income: [{ id: 'i1' }], cogs: [], team: [], operations: [], taxes: [] } },
  }
  assert.equal(hasFinancialMechanicsContext(withCashflow, financialEmpty), true)

  const withImported = normalizeFinancialMechanicsSession({
    imported_documents: { pl_articles: 'ok', cashflow_articles: '', business_process_raw: '' },
  })
  assert.equal(hasFinancialMechanicsContext(baseSession, withImported), true)
})

test('buildFinancialMechanicsFallbackQuestion follows block order', () => {
  const s1 = normalizeFinancialMechanicsSession({ completed_blocks: [] })
  assert.match(buildFinancialMechanicsFallbackQuestion(s1), /зарплата/i)

  const s2 = normalizeFinancialMechanicsSession({ completed_blocks: ['A', 'B', 'C', 'D'], skips: { E: true, F: false } })
  assert.match(buildFinancialMechanicsFallbackQuestion(s2), /кредити|лізинг|інвестори/i)
})

test('getMissingFinancialMechanicsSections returns required missing sections', () => {
  const empty = normalizeFinancialMechanicsSession({})
  assert.deepEqual(getMissingFinancialMechanicsSections(empty), [
    'Зарплата і виплати',
    'Власник',
    'Рекомендований метод P&L',
  ])

  const almostDone = normalizeFinancialMechanicsSession({
    salary_payouts: { period: 'щомісяця' },
    owner_payouts: { method: 'дивіденди' },
    recommended_pl_method: 'ok',
  })
  assert.deepEqual(getMissingFinancialMechanicsSections(almostDone), [])
})

test('buildFinancialMechanicsDocument renders core sections', () => {
  const fm = normalizeFinancialMechanicsSession({
    salary_payouts: { period: 'щомісяця', structure: 'фікс + бонус' },
    owner_payouts: { method: 'дивіденди', frequency: 'щокварталу' },
    recommended_pl_method: 'Рекомендується P&L по проектах.',
  })

  const doc = buildFinancialMechanicsDocument(
    { business_type: 'маркетингова агенція' },
    fm,
    new Date('2026-04-23T00:00:00.000Z')
  )

  assert.match(doc, /# Фінансова механіка бізнесу/)
  assert.match(doc, /\*\*Бізнес:\*\* маркетингова агенція/)
  assert.match(doc, /\*\*Дата:\*\* 2026-04-23/)
  assert.match(doc, /## Зарплата і виплати/)
  assert.match(doc, /## Власник/)
  assert.match(doc, /## Рекомендований метод P&L/)
})
