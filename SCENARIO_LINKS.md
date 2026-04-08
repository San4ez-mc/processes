# Посилання На Сценарії Telegram-Бота

Username бота: `fineko_processes_bot`.

## 1) Основний Бізнес-Процес (вже реалізовано)
Опис: повний сценарій від залучення клієнта до оплати і завершення.

Посилання:
https://t.me/fineko_processes_bot?start=main_process

## Заплановані Сценарії (ще не активні)
- `sales_process` — продаж і кваліфікація
- `operations_process` — виконання і виробництво
- `finance_process` — оплата і закриття

## Примітка
- Якщо payload відрізняється від `main_process`, бот повідомляє що сценарій у розробці і запускає `main_process`.
- Для коректної обробки голосових потрібен `OPENAI_API_KEY` (Whisper).
