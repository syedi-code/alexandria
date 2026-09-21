-- Migration: usage_events.
--
-- One row per billed turn. The same numbers are already in `messages.usage`,
-- but as JSON, so "how many turns has this user had this month?" is a scan of
-- every message ever written. That question is asked on the way into every
-- turn, under a 50-query budget, so it has to be an index.
--
-- Denormalised at save time and in the same transaction as the message, the
-- way citations already are.
--
-- `billing_month` is stored rather than derived because `substr(created_at,1,7)`
-- in a WHERE clause cannot use an index.

CREATE TABLE IF NOT EXISTS usage_events (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users(id),
    billing_month       TEXT NOT NULL,          -- 'YYYY-MM', UTC
    kind                TEXT NOT NULL,          -- 'chat_turn'
    model_id            TEXT,
    conversation_id     TEXT,
    message_id          TEXT,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL
);

-- The quota question: turns by this user in this month.
CREATE INDEX IF NOT EXISTS idx_usage_user_month
    ON usage_events(user_id, billing_month, kind);

-- The cost question: spend by model over a period.
CREATE INDEX IF NOT EXISTS idx_usage_month_model
    ON usage_events(billing_month, model_id);

-- Backfill from the turns already saved. `messages.usage` predates the cache
-- token fields, so those stay 0 for historical rows — a real zero, since
-- nothing was cached before this migration.
INSERT INTO usage_events (
    id, user_id, billing_month, kind, model_id, conversation_id, message_id,
    input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, created_at
)
SELECT
    m.id, c.user_id, substr(m.created_at, 1, 7), 'chat_turn', m.model_id,
    m.conversation_id, m.id,
    COALESCE(json_extract(m.usage, '$.inputTokens'), 0), 0, 0,
    COALESCE(json_extract(m.usage, '$.outputTokens'), 0), m.created_at
FROM messages m
JOIN conversations c ON c.id = m.conversation_id
WHERE m.usage IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM usage_events u WHERE u.id = m.id);
