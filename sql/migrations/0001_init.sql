-- D1 Migration: Initial Schema
-- Converted from Neon Postgres to SQLite-compatible DDL
-- 
-- Key changes from Postgres:
--   - UUID → TEXT (store as string)
--   - TIMESTAMP WITH TIME ZONE → TEXT (ISO8601 format)
--   - DATE → TEXT (YYYY-MM-DD format)
--   - JSONB → TEXT (JSON string, use json_extract() for queries)

-- Event Ledger: Core journal events
CREATE TABLE IF NOT EXISTS event_ledger (
    id TEXT PRIMARY KEY,
    "when" TEXT NOT NULL,
    type TEXT NOT NULL,
    channel TEXT NOT NULL,
    author TEXT NOT NULL,
    source TEXT NOT NULL,
    payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_ledger_when ON event_ledger("when" DESC);
CREATE INDEX IF NOT EXISTS idx_event_ledger_type ON event_ledger(type);

-- Weather Daily: Daily weather snapshots
CREATE TABLE IF NOT EXISTS weather_daily (
    date TEXT NOT NULL,
    zip TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (date, zip)
);

-- News Daily: Daily news headlines
CREATE TABLE IF NOT EXISTS news_daily (
    date TEXT PRIMARY KEY,
    source TEXT NOT NULL,git 
    data TEXT NOT NULL
);

-- YouTube Cache: Cached video metadata for enrichment
CREATE TABLE IF NOT EXISTS youtube_cache (
    video_id TEXT PRIMARY KEY,
    data TEXT NOT NULL
);
