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

## Примітка
- Сценарій `cashflow_items` запускається тільки після завершення `main_process`, бо використовує збережений `process_model` з блоку 1.
- На виході сценарій 2 формує JSON для Cashflow + P&L (з `cost_type`, `pl_level` і `pl_structure`).
- Для коректної обробки голосових потрібен `OPENAI_API_KEY` (Whisper).
