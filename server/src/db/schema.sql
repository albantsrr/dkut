-- Full schema for the Bibliothèque backend. Tables beyond `users` are created
-- now (even though only auth is wired up in phase 1) so later phases are pure
-- route/logic additions, not further migrations.

CREATE TABLE IF NOT EXISTS users (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub             TEXT NOT NULL UNIQUE,
  email                  TEXT NOT NULL,
  name                   TEXT NOT NULL,
  picture                TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  pomodoro_cycle_minutes INTEGER NOT NULL DEFAULT 25,
  pomodoro_break_minutes INTEGER NOT NULL DEFAULT 5
);
-- schema.sql is re-applied as-is on every `npm run migrate` (no versioned
-- migration runner, see server/src/db/migrate.js) — CREATE TABLE IF NOT
-- EXISTS alone wouldn't add these columns to a database that already has the
-- `users` table from before this change, hence the explicit ALTERs below.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pomodoro_cycle_minutes INTEGER NOT NULL DEFAULT 25;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pomodoro_break_minutes INTEGER NOT NULL DEFAULT 5;

CREATE TABLE IF NOT EXISTS books (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  author           TEXT NOT NULL,
  added_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  language         TEXT,
  translated_from  UUID REFERENCES books(id) ON DELETE SET NULL,
  file_path        TEXT NOT NULL,
  cover_path       TEXT
);
CREATE INDEX IF NOT EXISTS books_user_id_idx ON books(user_id);

CREATE TABLE IF NOT EXISTS progress (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id    UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  cfi        TEXT,
  pct        REAL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, book_id)
);

-- `id` is client-generated (default prompts use fixed ids like
-- 'default-revision-sheet', user-created ones use `custom-${Date.now()}` —
-- see src/components/ChatPanel.jsx), never server-generated, and savePrompt()
-- upserts by id — hence a plain TEXT id scoped by (user_id, id), not a
-- server-assigned UUID PK like the other tables.
CREATE TABLE IF NOT EXISTS custom_prompts (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS deleted_default_prompt_ids (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt_id TEXT NOT NULL,
  PRIMARY KEY (user_id, prompt_id)
);

CREATE TABLE IF NOT EXISTS quiz_progress (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id         UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_href    TEXT NOT NULL,
  mode            TEXT NOT NULL,
  questions_json  JSONB NOT NULL,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  best_score      INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 0,
  completed       BOOLEAN NOT NULL DEFAULT false,
  last_attempt_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, book_id, chapter_href, mode)
);

CREATE TABLE IF NOT EXISTS pomodoro_log (
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id             UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  sessions_completed  INTEGER NOT NULL DEFAULT 0,
  total_minutes       INTEGER NOT NULL DEFAULT 0,
  exercises_answered  INTEGER NOT NULL DEFAULT 0,
  exercises_correct   INTEGER NOT NULL DEFAULT 0,
  first_session_at    TIMESTAMPTZ,
  last_session_at     TIMESTAMPTZ,
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS revision_sheets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS revision_sheets_user_id_idx ON revision_sheets(user_id);
