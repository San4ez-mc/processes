'use strict'

function normalizeFinancialMechanicsSession(financialMechanicsSession) {
  const normalized = financialMechanicsSession || {}
  return {
    status: normalized.status || 'draft',
    current_block: normalized.current_block || 'A',
    completed_blocks: Array.isArray(normalized.completed_blocks) ? normalized.completed_blocks : [],
    skips: {
      E: Boolean(normalized?.skips?.E),
      F: Boolean(normalized?.skips?.F),
    },
    awaiting_context_files: Boolean(normalized.awaiting_context_files),
    pending_context_files: Array.isArray(normalized.pending_context_files) ? normalized.pending_context_files : [],
    imported_documents: {
      cashflow_articles: normalized?.imported_documents?.cashflow_articles || '',
      pl_articles: normalized?.imported_documents?.pl_articles || '',
      business_process_raw: normalized?.imported_documents?.business_process_raw || '',
    },
    salary_payouts: {
      period: normalized?.salary_payouts?.period || '',
      structure: normalized?.salary_payouts?.structure || '',
      bonuses: normalized?.salary_payouts?.bonuses || '',
      contractors: normalized?.salary_payouts?.contractors || '',
    },
    owner_payouts: {
      method: normalized?.owner_payouts?.method || '',
      frequency: normalized?.owner_payouts?.frequency || '',
      partners: normalized?.owner_payouts?.partners || '',
      market_owner_salary: normalized?.owner_payouts?.market_owner_salary || '',
    },
    prepayments: {
      from_clients: normalized?.prepayments?.from_clients || '',
      to_contractors: normalized?.prepayments?.to_contractors || '',
      average_gap_days: normalized?.prepayments?.average_gap_days || '',
    },
    projects: {
      project_pl_required: normalized?.projects?.project_pl_required || '',
      active_directions_count: normalized?.projects?.active_directions_count || '',
      shared_cost_method: normalized?.projects?.shared_cost_method || '',
    },
    inventory: {
      has_inventory: normalized?.inventory?.has_inventory || '',
      procurement_model: normalized?.inventory?.procurement_model || '',
      average_storage_days: normalized?.inventory?.average_storage_days || '',
    },
    loans: {
      has_liabilities: normalized?.loans?.has_liabilities || '',
      monthly_payment: normalized?.loans?.monthly_payment || '',
      interest_rate: normalized?.loans?.interest_rate || '',
      investors_terms: normalized?.loans?.investors_terms || '',
    },
    one_off_expenses: {
      has_assets: normalized?.one_off_expenses?.has_assets || '',
      assets_list: normalized?.one_off_expenses?.assets_list || '',
      planned_big_expenses: normalized?.one_off_expenses?.planned_big_expenses || '',
    },
    recommended_pl_method: normalized.recommended_pl_method || '',
    last_diagnosis_at: normalized.last_diagnosis_at || '',
    history: Array.isArray(normalized.history) ? normalized.history : [],
  }
}

function hasCompletedProcessModel(processModel) {
  return Boolean(processModel && processModel.status === 'complete' && Array.isArray(processModel.lanes))
}

function getCashflowItemsCount(cashflowSession) {
  const items = cashflowSession?.items || {}
  const buckets = ['income', 'cogs', 'team', 'operations', 'taxes']
  return buckets.reduce((sum, key) => sum + (Array.isArray(items[key]) ? items[key].length : 0), 0)
}

function hasFinancialMechanicsContext(session, financialSession) {
  const hasProcess = hasCompletedProcessModel(session.process_model)
  const hasCashflowItems = getCashflowItemsCount(session.cashflow_session) > 0
  const hasImportedPL = Boolean(financialSession?.imported_documents?.pl_articles || financialSession?.imported_documents?.cashflow_articles)
  return hasProcess && (hasCashflowItems || hasImportedPL)
}

function buildFinancialMechanicsContextRequestMessage() {
  return `Привіт! Схоже це перший раз коли ти звертаєшся до мене з цього акаунту.

Щоб пройти діагностику фінансової механіки —
мені потрібні файли з попередніх уроків:

📎 cashflow_articles.md — зі статтями Cashflow і P&L (урок 2.1)
📎 business_process.json — зі схемою бізнес-процесу (урок 1.2)

Прикріпи їх і я одразу почну.

Або якщо ти ще не проходив попередні уроки —
почни з початку курсу за посиланням:
https://t.me/fineko_processes_bot?start=main_process`
}

function buildFinancialMechanicsStartMessage(processModel) {
  const businessType = processModel?.business_type || 'не вказано'
  return `Починаємо діагностику фінансової механіки.

Я вже підтягнув контекст вашого бізнесу (${businessType}) з попередніх блоків, тому не будемо дублювати базові питання.

Блок А. Як зараз виплачується зарплата команді?`
}

function buildFinancialMechanicsFallbackQuestion(financialSession) {
  const completed = new Set(financialSession.completed_blocks || [])
  if (!completed.has('A')) return 'Як виплачується зарплата команді: раз на місяць, двічі на місяць чи по-різному?'
  if (!completed.has('B')) return 'Як власник бере гроші з бізнесу: зарплата, дивіденди чи змішано?'
  if (!completed.has('C')) return 'Чи берете передоплати від клієнтів і чи платите аванси підрядникам?'
  if (!completed.has('D')) return 'Чи є окремі проєкти/напрямки, де важливо бачити прибутковість окремо?'
  if (!completed.has('E') && !financialSession.skips.E) return 'Чи є склад або закупка матеріалів наперед?'
  if (!completed.has('F') && !financialSession.skips.F) return 'Чи є кредити, позики, лізинг або інвестори з виплатами?'
  if (!completed.has('G')) return 'Чи є велике обладнання або планові разові витрати на найближчий рік?'
  return 'Перевірте, будь ласка, чи все коректно зафіксовано, і підтвердьте фінальний підсумок.'
}

function isAnyValueFilled(obj) {
  if (!obj || typeof obj !== 'object') return false
  return Object.values(obj).some((value) => String(value || '').trim().length > 0)
}

function getMissingFinancialMechanicsSections(financialSession) {
  const missing = []
  if (!isAnyValueFilled(financialSession.salary_payouts)) {
    missing.push('Зарплата і виплати')
  }
  if (!isAnyValueFilled(financialSession.owner_payouts)) {
    missing.push('Власник')
  }
  if (!String(financialSession.recommended_pl_method || '').trim()) {
    missing.push('Рекомендований метод P&L')
  }
  return missing
}

function buildFinancialMechanicsDocument(processModel, financialSession, date = new Date()) {
  const businessName = processModel?.business_type || 'не вказано'
  const dateStr = new Date(date).toISOString().slice(0, 10)
  const lines = [
    '# Фінансова механіка бізнесу',
    `**Бізнес:** ${businessName}`,
    `**Дата:** ${dateStr}`,
    '',
    '## Зарплата і виплати',
    `- Periodичність: ${financialSession.salary_payouts.period || 'не вказано'}`,
    `- Структура: ${financialSession.salary_payouts.structure || 'не вказано'}`,
    `- Бонуси: ${financialSession.salary_payouts.bonuses || 'не вказано'}`,
    `- Підрядники: ${financialSession.salary_payouts.contractors || 'не вказано'}`,
    '',
    '## Власник',
    `- Спосіб виплати: ${financialSession.owner_payouts.method || 'не вказано'}`,
    `- Periodичність: ${financialSession.owner_payouts.frequency || 'не вказано'}`,
    `- Ринкова вартість роботи власника: ${financialSession.owner_payouts.market_owner_salary || 'не визначено'}`,
    '',
    '## Аванси і передоплати',
    `- Від клієнтів: ${financialSession.prepayments.from_clients || 'не вказано'}`,
    `- Підрядникам: ${financialSession.prepayments.to_contractors || 'не вказано'}`,
    `- Середній термін між авансом і виконанням: ${financialSession.prepayments.average_gap_days || 'не вказано'}`,
    '',
    '## Проекти і напрямки',
    `- P&L по проектах потрібен: ${financialSession.projects.project_pl_required || 'не вказано'}`,
    `- Кількість активних напрямків: ${financialSession.projects.active_directions_count || 'не вказано'}`,
    `- Розподіл спільних витрат: ${financialSession.projects.shared_cost_method || 'не вказано'}`,
    '',
    '## Склад і закупки',
    `- Є склад: ${financialSession.inventory.has_inventory || 'не вказано'}`,
    `- Модель закупки: ${financialSession.inventory.procurement_model || 'не вказано'}`,
    `- Середній термін зберігання: ${financialSession.inventory.average_storage_days || 'не вказано'}`,
    '',
    '## Кредити і відсотки',
    `- Є зобов'язання: ${financialSession.loans.has_liabilities || 'не вказано'}`,
    `- Щомісячні виплати: ${financialSession.loans.monthly_payment || 'не вказано'}`,
    `- Відсоткова ставка: ${financialSession.loans.interest_rate || 'не вказано'}`,
    '',
    '## Амортизація',
    `- Є активи для амортизації: ${financialSession.one_off_expenses.has_assets || 'не вказано'}`,
    `- Активи: ${financialSession.one_off_expenses.assets_list || 'не вказано'}`,
    '',
    '## Рекомендований метод P&L',
    financialSession.recommended_pl_method || 'Рекомендації потребують уточнення.',
  ]

  return lines.join('\n')
}

function isFinancialMechanicsTrigger(text) {
  const normalized = String(text || '').toLowerCase()
  return /(діагностик|механік|як рахувати p&l|зарплат|дивіденд|аванс|проєкт|проект)/.test(normalized)
}

module.exports = {
  normalizeFinancialMechanicsSession,
  hasCompletedProcessModel,
  getCashflowItemsCount,
  hasFinancialMechanicsContext,
  buildFinancialMechanicsContextRequestMessage,
  buildFinancialMechanicsStartMessage,
  buildFinancialMechanicsFallbackQuestion,
  getMissingFinancialMechanicsSections,
  isAnyValueFilled,
  buildFinancialMechanicsDocument,
  isFinancialMechanicsTrigger,
}
