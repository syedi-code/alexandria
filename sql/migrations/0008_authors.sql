-- Migration: Add authors table and link books to authors
-- Authors are a first-class entity with biographical metadata

CREATE TABLE IF NOT EXISTS authors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    bio TEXT,
    born TEXT,       -- Flexible format: "1984", "4 BCE", "c. 55 CE"
    died TEXT,       -- Flexible format: same as born, NULL if still alive
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_authors_name ON authors(name);

-- Add author_id foreign key to books
ALTER TABLE books ADD COLUMN author_id TEXT REFERENCES authors(id);

CREATE INDEX IF NOT EXISTS idx_books_author_id ON books(author_id);
