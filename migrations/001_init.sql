-- Міграція 001: Створення таблиці сесій
-- Запуск: node -e "require('./src/db').runMigration()"

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id         BIGINT UNIQUE NOT NULL,
  process_model       JSONB NOT NULL DEFAULT '{}',
  mermaid_code        TEXT,
  history             JSONB NOT NULL DEFAULT '[]',
  status              VARCHAR(20) NOT NULL DEFAULT 'draft',
  validation_attempts INT NOT NULL DEFAULT 0,
  current_block       INT NOT NULL DEFAULT 0,
  completed_blocks    JSONB NOT NULL DEFAULT '[]',
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_telegram_id ON sessions(telegram_id);

-- Автоматичне оновлення updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_sessions_updated_at ON sessions;
CREATE TRIGGER update_sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
