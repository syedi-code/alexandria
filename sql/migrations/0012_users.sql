-- Migration: Add users table and user_id ownership columns
-- Adds Cloudflare Access user tracking and ownership attribution to all entities.
-- Role is computed at runtime (email === ADMIN_EMAIL → admin, else member).

-- =============================================================================
-- Users table
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,           -- CF Access 'sub' UUID (stable across sessions)
    email TEXT NOT NULL UNIQUE,    -- Verified email from JWT payload
    name TEXT,                     -- Display name (optional)
    idp_type TEXT,                 -- Identity provider, e.g. 'github'
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- Add user_id ownership column to all entity tables
-- Uses a placeholder value until the admin's real CF Access sub is known.
-- After first admin login, run:
--   UPDATE <table> SET user_id = '<real-sub>' WHERE user_id = 'admin-placeholder'
-- =============================================================================
ALTER TABLE notes       ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE quotes      ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE thoughts    ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE media       ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE links       ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE sleep       ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE books       ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE authors     ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE threads     ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE connections ADD COLUMN user_id TEXT REFERENCES users(id);

-- =============================================================================
-- Indexes for user_id lookups
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_notes_user       ON notes(user_id);
CREATE INDEX IF NOT EXISTS idx_quotes_user      ON quotes(user_id);
CREATE INDEX IF NOT EXISTS idx_thoughts_user    ON thoughts(user_id);
CREATE INDEX IF NOT EXISTS idx_media_user       ON media(user_id);
CREATE INDEX IF NOT EXISTS idx_links_user       ON links(user_id);
CREATE INDEX IF NOT EXISTS idx_sleep_user       ON sleep(user_id);
CREATE INDEX IF NOT EXISTS idx_books_user       ON books(user_id);
CREATE INDEX IF NOT EXISTS idx_authors_user     ON authors(user_id);
CREATE INDEX IF NOT EXISTS idx_threads_user     ON threads(user_id);
CREATE INDEX IF NOT EXISTS idx_connections_user ON connections(user_id);
