-- D1 Schema: Authors
-- First-class entity for book authors with biographical metadata

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
