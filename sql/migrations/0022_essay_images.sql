-- Migration: Add essay_images table
-- Inline image embeds for essays. Each row owns an R2 object plus optional
-- caption + source URL. Referenced from essay content via [[image:UUID]]
-- tokens, materialised as essay_references rows with entity_type='image'.
--
-- Images are user-owned, not essay-owned: the same image may be embedded
-- in multiple essays. Cleanup is intentionally manual — orphaned rows
-- linger until a janitor or the user removes them.

CREATE TABLE IF NOT EXISTS essay_images (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    path        TEXT NOT NULL,
    mime_type   TEXT,
    caption     TEXT,
    source_url  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_essay_images_user ON essay_images(user_id);
