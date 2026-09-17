-- Migration: Denormalize event_ledger into typed tables
-- Promotes notes, quotes, media, links, and sleep from JSON blobs
-- in event_ledger to proper columnar tables with typed fields.
-- The event_ledger table is kept intact as a legacy archive.

-- =============================================================================
-- Notes
-- =============================================================================
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    book_id TEXT REFERENCES books(id),
    page TEXT,                            -- Print page ref: "42", "42-45", "xiv"
    posted INTEGER NOT NULL DEFAULT 0,    -- 0 = unposted, 1 = posted
    tags TEXT,                            -- JSON array of strings
    replaces TEXT,                        -- ID of previous version (append-only versioning)
    source TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_book_id ON notes(book_id) WHERE book_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_replaces ON notes(replaces) WHERE replaces IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_posted ON notes(posted);

-- =============================================================================
-- Quotes
-- =============================================================================
CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    quote TEXT NOT NULL,
    work TEXT,                            -- Title of the source work
    creator TEXT,                         -- Author/creator of the quoted work
    kind TEXT,                            -- video|movie|tv|game|book|podcast|song|article
    book_id TEXT REFERENCES books(id),
    page TEXT,                            -- Print page ref
    posted INTEGER NOT NULL DEFAULT 0,
    tags TEXT,                            -- JSON array of strings
    replaces TEXT,                        -- ID of previous version
    source TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quotes_created_at ON quotes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_book_id ON quotes(book_id) WHERE book_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quotes_replaces ON quotes(replaces) WHERE replaces IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quotes_posted ON quotes(posted);

-- =============================================================================
-- Media
-- =============================================================================
CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    title TEXT,
    url TEXT,
    kind TEXT NOT NULL,                   -- video|movie|tv|game|book|podcast|song|article
    creator TEXT,
    note TEXT,                            -- Optional annotation
    posted INTEGER NOT NULL DEFAULT 0,
    tags TEXT,                            -- JSON array of strings
    source TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_created_at ON media(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind);

-- =============================================================================
-- Links
-- =============================================================================
CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    title TEXT,
    url TEXT NOT NULL,
    site TEXT,                            -- Domain or publisher name
    og_title TEXT,                        -- OpenGraph title if different
    note TEXT,                            -- Optional annotation
    posted INTEGER NOT NULL DEFAULT 0,
    tags TEXT,                            -- JSON array of strings
    source TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_links_posted ON links(posted);

-- =============================================================================
-- Sleep
-- =============================================================================
CREATE TABLE IF NOT EXISTS sleep (
    id TEXT PRIMARY KEY,
    hours REAL NOT NULL CHECK(hours >= 0 AND hours <= 24),
    quality INTEGER CHECK(quality IS NULL OR (quality >= 0 AND quality <= 10)),
    bed_time TEXT,                        -- ISO 8601 datetime
    wake_time TEXT,                       -- ISO 8601 datetime
    note TEXT,                            -- Optional annotation
    tags TEXT,                            -- JSON array of strings
    source TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sleep_created_at ON sleep(created_at DESC);
