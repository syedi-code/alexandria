-- D1 Schema: Denormalized event tables
-- Notes, Quotes, Media, Links, and Sleep as first-class columnar tables
-- Replaces the generic event_ledger JSON blob pattern for these types

-- Notes: journal entries, reading notes, observations
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    creator TEXT,
    work TEXT,
    kind TEXT,
    book_id TEXT REFERENCES books(id),
    page TEXT,
    posted INTEGER NOT NULL DEFAULT 0,
    tags TEXT,
    replaces TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_surfaced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_book_id ON notes(book_id) WHERE book_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_replaces ON notes(replaces) WHERE replaces IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_posted ON notes(posted);

-- Quotes: attributed passages from books, media, conversations
CREATE TABLE IF NOT EXISTS quotes (
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
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quotes_created_at ON quotes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_book_id ON quotes(book_id) WHERE book_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quotes_replaces ON quotes(replaces) WHERE replaces IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quotes_posted ON quotes(posted);

-- Media: movies, games, shows, songs, podcasts, articles consumed
CREATE TABLE IF NOT EXISTS media (
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
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_created_at ON media(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind);

-- Links: bookmarked URLs with metadata
CREATE TABLE IF NOT EXISTS links (
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
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_links_posted ON links(posted);

-- Sleep: sleep tracking entries
CREATE TABLE IF NOT EXISTS sleep (
    id TEXT PRIMARY KEY,
    hours REAL NOT NULL CHECK(hours >= 0 AND hours <= 24),
    quality INTEGER CHECK(quality IS NULL OR (quality >= 0 AND quality <= 10)),
    bed_time TEXT,
    wake_time TEXT,
    note TEXT,
    tags TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sleep_created_at ON sleep(created_at DESC);
