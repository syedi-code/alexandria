-- D1 Schema: Thoughts Table
-- Standalone table for network-visualized thoughts
-- Separate from event_ledger to emphasize different medium/affordance

CREATE TABLE IF NOT EXISTS thoughts (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL,
    -- 2D position for network visualization (computed from embedding, cached)
    x REAL,
    y REAL,
    -- Mood tracking (optional)
    mood_score INTEGER CHECK(mood_score IS NULL OR (mood_score >= 1 AND mood_score <= 10)),
    mood_tags TEXT -- JSON array of mood strings, e.g. '["happy", "excited", "grateful"]'
);

CREATE INDEX IF NOT EXISTS idx_thoughts_created_at ON thoughts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thoughts_mood_score ON thoughts(mood_score) WHERE mood_score IS NOT NULL;
