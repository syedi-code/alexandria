-- Migration: make essay_references polymorphic over (entity_type, entity_id)
-- Replaces single book_id column with (entity_type, entity_id), supporting
-- 'book' (bibliography reference, existing), 'quote' (embedded quote slide),
-- and 'book_cover' (embedded full-bleed cover slide).
--
-- Existing rows are migrated to entity_type='book'; entity_id receives
-- the previous book_id value. The unique index now allows the same book
-- to appear once per kind (e.g. as both a bibliography entry and a cover).

CREATE TABLE IF NOT EXISTS essay_references_new (
    id TEXT PRIMARY KEY,
    essay_id TEXT NOT NULL REFERENCES essays(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    page TEXT,
    position INTEGER NOT NULL DEFAULT 0
);

INSERT INTO essay_references_new (id, essay_id, entity_type, entity_id, page, position)
    SELECT id, essay_id, 'book', book_id, page, position
    FROM essay_references;

DROP TABLE essay_references;
ALTER TABLE essay_references_new RENAME TO essay_references;

CREATE INDEX IF NOT EXISTS idx_essay_refs_essay ON essay_references(essay_id);
CREATE INDEX IF NOT EXISTS idx_essay_refs_entity ON essay_references(entity_type, entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_essay_refs_unique
    ON essay_references(essay_id, entity_type, entity_id);
