-- D1 Schema: Books Library
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
    originally_published TEXT,
    pdf_page_offset INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_created_at ON books(created_at DESC);

-- Note: Notes and Quotes link to books via book_id field in their JSON payload
-- Page references are stored as "page" field (print page string) in the payload
-- PDF page is calculated at render time: pdf_page = print_page + pdf_page_offset
