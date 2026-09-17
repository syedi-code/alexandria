-- Migration: Add essays and essay_references tables
-- Essays are short-form reflections referencing one or more books.
-- Uses a dedicated essay_references join table for multi-book references
-- with per-reference page metadata and display ordering.

-- =============================================================================
-- Essays table
-- =============================================================================
CREATE TABLE IF NOT EXISTS essays (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    posted INTEGER NOT NULL DEFAULT 0,
    tags TEXT,
    replaces TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_essays_created_at ON essays(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_essays_replaces ON essays(replaces) WHERE replaces IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_essays_posted ON essays(posted);
CREATE INDEX IF NOT EXISTS idx_essays_user ON essays(user_id);

-- =============================================================================
-- Essay References join table (essay → book, with page + position)
-- =============================================================================
CREATE TABLE IF NOT EXISTS essay_references (
    id TEXT PRIMARY KEY,
    essay_id TEXT NOT NULL REFERENCES essays(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id),
    page TEXT,
    position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_essay_refs_essay ON essay_references(essay_id);
CREATE INDEX IF NOT EXISTS idx_essay_refs_book ON essay_references(book_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_essay_refs_unique ON essay_references(essay_id, book_id);
