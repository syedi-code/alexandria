-- Migration: conversations.
--
-- A Conversation is one person's exchange with Scribe. Private to its owner,
-- like Writing, but not Writing: the person did not write the answers. It
-- points at Works through citations; Works never point back.
--
-- Messages store AI SDK UIMessage parts verbatim, so tool calls, tool results
-- and citation data round-trip exactly. Citations are denormalised out of those
-- parts at save time, so "how often do citations verify, per model?" is an
-- indexed query rather than a JSON scan.

CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    title       TEXT,
    model_id    TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversations_user
    ON conversations(user_id, updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS messages (
    id               TEXT PRIMARY KEY,
    conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq              INTEGER NOT NULL,
    role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    parts            TEXT NOT NULL,
    model_id         TEXT,
    usage            TEXT,
    created_at       TEXT NOT NULL,
    UNIQUE (conversation_id, seq)
);

CREATE TABLE IF NOT EXISTS citations (
    id           TEXT PRIMARY KEY,
    message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    document_id  TEXT NOT NULL REFERENCES documents(id),
    page_no      INTEGER NOT NULL,
    quote        TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('verified', 'unverified', 'unverifiable')),
    created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_citations_message ON citations(message_id);
CREATE INDEX IF NOT EXISTS idx_citations_document ON citations(document_id, page_no);
