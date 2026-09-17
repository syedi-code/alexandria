-- Migration: Add polymorphic connections table
-- Enables any entity to link to any other entity via typed edges.
-- Replaces hard-coded FK columns (notes.book_id, quotes.book_id, books.author_id)
-- with a uniform connection mechanism.

-- =============================================================================
-- Connections table
-- =============================================================================
CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    a_type TEXT NOT NULL,      -- Entity type (author, book, media, note, quote, thought)
    a_id TEXT NOT NULL,        -- Entity UUID
    b_type TEXT NOT NULL,      -- Entity type
    b_id TEXT NOT NULL,        -- Entity UUID
    metadata TEXT,             -- Optional JSON (e.g. {"page": "42"})
    created_at TEXT NOT NULL
);

-- Convention: a_type <= b_type alphabetically, enforced in application code.
-- This ensures (a_type, a_id, b_type, b_id) is canonical and the UNIQUE constraint works.

CREATE INDEX IF NOT EXISTS idx_connections_a ON connections(a_type, a_id);
CREATE INDEX IF NOT EXISTS idx_connections_b ON connections(b_type, b_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_unique ON connections(a_type, a_id, b_type, b_id);

-- =============================================================================
-- Backfill existing FK relationships into connections
-- =============================================================================

-- notes.book_id → connection (book, <book_id>, note, <note_id>)
-- 'book' < 'note' alphabetically, so book goes in a_type
INSERT INTO connections (id, a_type, a_id, b_type, b_id, metadata, created_at)
SELECT
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
    'book',
    book_id,
    'note',
    id,
    CASE WHEN page IS NOT NULL THEN json_object('page', page) ELSE NULL END,
    created_at
FROM notes
WHERE book_id IS NOT NULL;

-- quotes.book_id → connection (book, <book_id>, quote, <quote_id>)
-- 'book' < 'quote' alphabetically
INSERT INTO connections (id, a_type, a_id, b_type, b_id, metadata, created_at)
SELECT
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
    'book',
    book_id,
    'quote',
    id,
    CASE WHEN page IS NOT NULL THEN json_object('page', page) ELSE NULL END,
    created_at
FROM quotes
WHERE book_id IS NOT NULL;

-- books.author_id → connection (author, <author_id>, book, <book_id>)
-- 'author' < 'book' alphabetically
INSERT INTO connections (id, a_type, a_id, b_type, b_id, metadata, created_at)
SELECT
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
    'author',
    author_id,
    'book',
    id,
    NULL,
    created_at
FROM books
WHERE author_id IS NOT NULL;
