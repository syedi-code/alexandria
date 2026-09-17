-- Migration: Add params JSON column to essay_references
-- Per-embed presentation overrides (e.g. quote font size, image background,
-- token-local image caption) are parsed from the inline token grammar at save
-- time and stored as JSON here. Old rows have NULL; renderers fall back to
-- defaults when absent.

ALTER TABLE essay_references ADD COLUMN params TEXT;
