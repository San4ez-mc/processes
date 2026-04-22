# Посилання На Сценарії Telegram-Бота

Username бота: `fineko_processes_bot`.

## 1) Основний Бізнес-Процес (вже реалізовано)
Опис: повний сценарій від залучення клієнта до оплати і завершення.

Посилання:
https://t.me/fineko_processes_bot?start=main_process

## 2) Cashflow + P&L статті
Опис: збір єдиного персоналізованого списку доходів і витрат для обох шаблонів — Cashflow і P&L — на основі вже побудованого бізнес-процесу.

Посилання:
https://t.me/fineko_processes_bot?start=cashflow_items

## 3) Діагностика фінансової механіки (урок 3.3)
Опис: діалогова діагностика того, як рухаються гроші в бізнесі (зарплати, дивіденди, аванси, проєкти, склад, кредити, великі витрати) з формуванням файлу `financial_mechanics.md`.

Посилання:
https://t.me/fineko_processes_bot?start=lesson_3_3_diagnosis

## Примітка
- Сценарій `cashflow_items` запускається тільки після завершення `main_process`, бо використовує збережений `process_model` з блоку 1.
- На виході сценарій 2 формує JSON для Cashflow + P&L (з `cost_type`, `pl_level` і `pl_structure`).
- Сценарій `financial_mechanics_diagnosis` запускається через deep link `lesson_3_3_diagnosis` або по текстовому тригеру (діагностика/механіка/P&L) і використовує збережені дані користувача за `telegram_user_id`.
- Якщо контекст відсутній, сценарій 3 запитує імпорт файлів `cashflow_articles.md` і `business_process.json`.
- Для коректної обробки голосових потрібен `OPENAI_API_KEY` (Whisper).
