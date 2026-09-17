-- Add free-text attribution columns to notes (matching quotes table pattern)
ALTER TABLE notes ADD COLUMN creator TEXT;
ALTER TABLE notes ADD COLUMN work TEXT;
ALTER TABLE notes ADD COLUMN kind TEXT;
