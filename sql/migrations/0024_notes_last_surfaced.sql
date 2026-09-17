-- Shuffle mode: track when a note was last dealt so weighted sampling can
-- favour notes the user hasn't seen in a long time. NULL = never surfaced.
ALTER TABLE notes ADD COLUMN last_surfaced_at TEXT;
