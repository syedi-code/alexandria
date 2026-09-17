-- Migration: Add thoughts table
-- Thoughts are a separate object type from Notes
-- Designed for network visualization with embedding-based clustering

CREATE TABLE IF NOT EXISTS thoughts (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL,
    -- 2D position for network visualization (computed from embedding, cached)
    x REAL,
    y REAL
);

CREATE INDEX IF NOT EXISTS idx_thoughts_created_at ON thoughts(created_at DESC);
