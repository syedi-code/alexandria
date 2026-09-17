-- Rename year_written to originally_published and change type from INTEGER to TEXT
-- This allows for flexible date formats like "1984", "237 BCE", "c. 1850"

-- SQLite doesn't support ALTER COLUMN, so we need to:
-- 1. Create a new table with the correct schema
-- 2. Copy data, converting integers to strings
-- 3. Drop the old table
-- 4. Rename the new table

-- Create new table with originally_published as TEXT
CREATE TABLE books_new (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    pdf_url TEXT,
    cover_url TEXT,
    isbn TEXT,
    description TEXT,
    originally_published TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Copy data, converting year_written integer to string
INSERT INTO books_new (id, title, author, pdf_url, cover_url, isbn, description, originally_published, created_at, updated_at)
SELECT id, title, author, pdf_url, cover_url, isbn, description, 
       CASE WHEN year_written IS NOT NULL THEN CAST(year_written AS TEXT) ELSE NULL END,
       created_at, updated_at
FROM books;

-- Drop old table
DROP TABLE books;

-- Rename new table
ALTER TABLE books_new RENAME TO books;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_created_at ON books(created_at DESC);
