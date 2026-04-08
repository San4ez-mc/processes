# Деплой на хостинг Україна (Ubuntu VPS)

## Вимоги до сервера
- Ubuntu 22.04 LTS
- RAM: мінімум 1 GB (рекомендовано 2 GB для Puppeteer)
- Диск: 5 GB вільного місця (Chromium ~300 MB)

---

## 1. Підготовка сервера

```bash
# Оновлення системи
sudo apt update && sudo apt upgrade -y

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Chromium (для mermaid-cli/Puppeteer)
sudo apt install -y chromium-browser fonts-liberation libappindicator3-1 \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
  libgdk-pixbuf2.0-0 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 \
  libxcomposite1 libxdamage1 libxrandr2 xdg-utils

# PM2 (менеджер процесів)
sudo npm install -g pm2

# Git
sudo apt install -y git
```

---

## 2. Налаштування PostgreSQL

```bash
sudo -u postgres psql

# В psql консолі:
CREATE USER botuser WITH PASSWORD 'ваш_надійний_пароль';
CREATE DATABASE business_agent OWNER botuser;
GRANT ALL PRIVILEGES ON DATABASE business_agent TO botuser;
\q
```

---

## 3. Розгортання проєкту

```bash
# Клонуємо або завантажуємо проєкт
cd /var/www
git clone https://github.com/your-repo/business-process-agent.git
cd business-process-agent

# Встановлюємо залежності
npm install

# Налаштовуємо змінні середовища
cp .env.example .env
nano .env
# Заповнюємо: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, DATABASE_URL
```

---

## 4. Файл .env (приклад заповненого)

```
TELEGRAM_BOT_TOKEN=1234567890:AAF-xxxxxxxxxxxxx
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-api03-xxxxx
LLM_MODEL=claude-sonnet-4-5
DATABASE_URL=postgresql://botuser:ваш_пароль@localhost:5432/business_agent
NODE_ENV=production
DB_SSL=false
MERMAID_TMP_DIR=/tmp/mermaid
```

---

## 5. Запуск міграції БД

```bash
node -e "require('./src/db').runMigration()"
```

---

## 6. Запуск через PM2

```bash
# Створюємо папку для логів
mkdir -p logs

# Запуск
pm2 start ecosystem.config.js

# Автозапуск після перезавантаження
pm2 startup
pm2 save

# Перегляд логів
pm2 logs business-process-agent
```

---

## 7. Перевірка роботи

```bash
# Статус процесу
pm2 status

# Логи в реальному часі
pm2 logs --lines 50

# Перезапуск
pm2 restart business-process-agent
```

---

## Популярні хостинги України

| Хостинг | VPS тариф | Примітка |
|---------|-----------|----------|
| [mirohost.net](https://mirohost.net) | від 150 грн/міс | Ubuntu, гарна підтримка |
| [ukraine.com.ua](https://ukraine.com.ua) | від 100 грн/міс | VPS з SSD |
| [freehost.com.ua](https://freehost.com.ua) | від 80 грн/міс | Node.js підтримка |
| [tucha.ua](https://tucha.ua) | від 200 грн/міс | Хмара, надійно |

**Рекомендація:** Обирайте VPS мінімум з 1-2 GB RAM через Puppeteer.

---

## Отримання Telegram Bot Token

1. Відкрийте [@BotFather](https://t.me/BotFather) в Telegram
2. `/newbot` → введіть назву → отримайте token

## Отримання Anthropic API Key

1. Зареєструйтесь на [console.anthropic.com](https://console.anthropic.com)
2. API Keys → Create Key
