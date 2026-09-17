-- Migration: Enforce NOT NULL on user_id for all tenant-scoped entity tables
-- SQLite does not support ALTER COLUMN, so each table must be recreated.
-- Books and authors are excluded — they are shared public resources.

-- =============================================================================
-- Notes
-- =============================================================================
CREATE TABLE notes_new (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    book_id TEXT REFERENCES books(id),
    page TEXT,
    posted INTEGER NOT NULL DEFAULT 0,
    tags TEXT,
    replaces TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id)
);
INSERT INTO notes_new SELECT * FROM notes;
DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;

CREATE INDEX idx_notes_created_at ON notes(created_at DESC);
CREATE INDEX idx_notes_book_id ON notes(book_id) WHERE book_id IS NOT NULL;
CREATE INDEX idx_notes_replaces ON notes(replaces) WHERE replaces IS NOT NULL;
CREATE INDEX idx_notes_posted ON notes(posted);
CREATE INDEX idx_notes_user ON notes(user_id);

-- =============================================================================
-- Quotes
-- =============================================================================
CREATE TABLE quotes_new (
    id TEXT PRIMARY KEY,
    quote TEXT NOT NULL,
    work TEXT,
    creator TEXT,
    kind TEXT,
    book_id TEXT REFERENCES books(id),
    page TEXT,
    posted INTEGER NOT NULL DEFAULT 0,
    tags TEXT,
    replaces TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id)
);
INSERT INTO quotes_new SELECT * FROM quotes;
DROP TABLE quotes;
ALTER TABLE quotes_new RENAME TO quotes;

CREATE INDEX idx_quotes_created_at ON quotes(created_at DESC);
CREATE INDEX idx_quotes_book_id ON quotes(book_id) WHERE book_id IS NOT NULL;
CREATE INDEX idx_quotes_replaces ON quotes(replaces) WHERE replaces IS NOT NULL;
CREATE INDEX idx_quotes_posted ON quotes(posted);
CREATE INDEX idx_quotes_user ON quotes(user_id);

-- =============================================================================
-- Thoughts
-- =============================================================================
CREATE TABLE thoughts_new (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL,
    x REAL,
    y REAL,
    mood_score INTEGER,
    mood_tags TEXT,
    user_id TEXT NOT NULL REFERENCES users(id)
);
INSERT INTO thoughts_new SELECT * FROM thoughts;
DROP TABLE thoughts;
ALTER TABLE thoughts_new RENAME TO thoughts;

CREATE INDEX idx_thoughts_created_at ON thoughts(created_at DESC);
CREATE INDEX idx_thoughts_mood_score ON thoughts(mood_score);
CREATE INDEX idx_thoughts_user ON thoughts(user_id);

-- =============================================================================
-- Media
-- =============================================================================
CREATE TABLE media_new (
    id TEXT PRIMARY KEY,
    title TEXT,
    url TEXT,
    kind TEXT NOT NULL,
    creator TEXT,
    note TEXT,
    posted INTEGER NOT NULL DEFAULT 0,
    tags TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id)
);
INSERT INTO media_new SELECT * FROM media;
DROP TABLE media;
ALTER TABLE media_new RENAME TO media;

CREATE INDEX idx_media_created_at ON media(created_at DESC);
CREATE INDEX idx_media_kind ON media(kind);
CREATE INDEX idx_media_user ON media(user_id);

-- =============================================================================
-- Links
-- =============================================================================
CREATE TABLE links_new (
    id TEXT PRIMARY KEY,
    title TEXT,
    url TEXT NOT NULL,
    site TEXT,
    og_title TEXT,
    note TEXT,
    posted INTEGER NOT NULL DEFAULT 0,
    tags TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id)
);
INSERT INTO links_new SELECT * FROM links;
DROP TABLE links;
ALTER TABLE links_new RENAME TO links;

CREATE INDEX idx_links_created_at ON links(created_at DESC);
CREATE INDEX idx_links_posted ON links(posted);
CREATE INDEX idx_links_user ON links(user_id);

-- =============================================================================
-- Sleep
-- =============================================================================
CREATE TABLE sleep_new (
    id TEXT PRIMARY KEY,
    hours REAL NOT NULL CHECK(hours >= 0 AND hours <= 24),
    quality INTEGER CHECK(quality IS NULL OR (quality >= 0 AND quality <= 10)),
    bed_time TEXT,
    wake_time TEXT,
    note TEXT,
    tags TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id)
);
INSERT INTO sleep_new SELECT * FROM sleep;
DROP TABLE sleep;
ALTER TABLE sleep_new RENAME TO sleep;

CREATE INDEX idx_sleep_created_at ON sleep(created_at DESC);
CREATE INDEX idx_sleep_user ON sleep(user_id);

-- =============================================================================
-- Connections
-- =============================================================================
CREATE TABLE connections_new (
    id TEXT PRIMARY KEY,
    a_type TEXT NOT NULL,
    a_id TEXT NOT NULL,
    b_type TEXT NOT NULL,
    b_id TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id)
);
INSERT INTO connections_new SELECT * FROM connections;
DROP TABLE connections;
ALTER TABLE connections_new RENAME TO connections;

CREATE INDEX idx_connections_a ON connections(a_type, a_id);
CREATE INDEX idx_connections_b ON connections(b_type, b_id);
CREATE UNIQUE INDEX idx_connections_unique ON connections(a_type, a_id, b_type, b_id);
CREATE INDEX idx_connections_user ON connections(user_id);

-- =============================================================================
-- Threads
-- =============================================================================
CREATE TABLE threads_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id)
);
INSERT INTO threads_new SELECT * FROM threads;
DROP TABLE threads;
ALTER TABLE threads_new RENAME TO threads;

CREATE INDEX idx_threads_user ON threads(user_id);
