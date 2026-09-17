-- D1 Migration: Books Library
-- Adds support for book management with PDF storage

-- Books table: Reference data for books in the library
CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    pdf_url TEXT,
    cover_url TEXT,
    isbn TEXT,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_created_at ON books(created_at DESC);

-- Note: Notes link to books via book_id field in their JSON payload
-- No schema change needed for event_ledger since we use flexible JSON storage
