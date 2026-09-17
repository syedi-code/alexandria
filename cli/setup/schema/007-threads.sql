-- D1 Schema: Threads — Named Ordered Collections
-- Threads are named, ordered collections of Notes, Thoughts, Quotes, and Books.

CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_items (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_items_unique
    ON thread_items(thread_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_thread_items_thread
    ON thread_items(thread_id);

CREATE INDEX IF NOT EXISTS idx_thread_items_entity
    ON thread_items(entity_type, entity_id);
