-- Migration: Add mood tracking to thoughts table
-- mood_score: Optional 1-10 mood rating
-- mood_tags: JSON array of mood descriptors for autocomplete

ALTER TABLE thoughts ADD COLUMN mood_score INTEGER;
ALTER TABLE thoughts ADD COLUMN mood_tags TEXT;

-- Index for mood-based queries
CREATE INDEX IF NOT EXISTS idx_thoughts_mood_score ON thoughts(mood_score);
