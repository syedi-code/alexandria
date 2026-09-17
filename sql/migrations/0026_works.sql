-- Migration: books → works.
--
-- A Work is anything a Note or Quote can attach to: a book, a lecture, an
-- article, a film. `books` was already that table in everything but name, so
-- this renames rather than copies.
--
-- Renaming matters for more than tidiness. notes.book_id and quotes.book_id
-- carry REFERENCES books(id), and SQLite rewrites those clauses in place when
-- the referenced table is renamed. Copying into a new table instead would
-- leave both FKs pointing at a table that no longer exists, and every new note
-- would fail once foreign_keys came back on.
--
-- Every id is preserved. Work ids are embedded in essay prose as [[book:UUID]]
-- tokens, so remapping one silently corrupts an essay written years ago.
-- Nothing in this file generates an id except `documents`, which is new.
--
-- The `book_id` column names on notes, quotes and essay_references are left
-- alone: a column name is not a contract, and renaming them would mean
-- rewriting the tokens.

-- =============================================================================
-- Rename
-- =============================================================================

ALTER TABLE authors    RENAME TO creators;
ALTER TABLE books      RENAME TO works;
ALTER TABLE book_media RENAME TO work_media;

ALTER TABLE works      RENAME COLUMN author    TO creator;
ALTER TABLE works      RENAME COLUMN author_id TO creator_id;
ALTER TABLE works      RENAME COLUMN cover_url TO cover_key;

ALTER TABLE work_media RENAME COLUMN book_id TO work_id;
ALTER TABLE work_media RENAME COLUMN path    TO r2_key;

-- =============================================================================
-- Widen works beyond books
-- =============================================================================

ALTER TABLE works ADD COLUMN kind TEXT NOT NULL DEFAULT 'book';
ALTER TABLE works ADD COLUMN primary_document_id TEXT;
ALTER TABLE works ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_works_kind ON works(kind);
CREATE INDEX IF NOT EXISTS idx_works_deleted ON works(deleted_at) WHERE deleted_at IS NOT NULL;

-- =============================================================================
-- Documents: a concrete file a Work exists as
-- =============================================================================
-- Pagination belongs to the file, not to the work — books.pdf_page_offset was
-- already proof of that. Philosophy means translations, so "page 47" is only
-- meaningful once you know which edition.

CREATE TABLE IF NOT EXISTS documents (
    id                       TEXT PRIMARY KEY,
    work_id                  TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    r2_key                   TEXT,
    label                    TEXT,
    page_offset              INTEGER NOT NULL DEFAULT 0,
    page_count               INTEGER,
    is_primary               INTEGER NOT NULL DEFAULT 0,
    current_transcription_id TEXT,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_work ON documents(work_id, is_primary DESC);

-- =============================================================================
-- Transcriptions: one extraction run over one document
-- =============================================================================
-- Keyed to the document rather than the work so two models, or two editions,
-- can be compared. Citation verification rate against pages.text is how a
-- transcription gets judged, which makes this the evaluation substrate for
-- chat, not just a cache of text.

CREATE TABLE IF NOT EXISTS transcriptions (
    id             TEXT PRIMARY KEY,
    document_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    model          TEXT NOT NULL,
    prompt_version TEXT,
    status         TEXT NOT NULL DEFAULT 'pending',
    started_at     TEXT,
    finished_at    TEXT,
    cost           REAL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transcriptions_document ON transcriptions(document_id);

CREATE TABLE IF NOT EXISTS pages (
    transcription_id TEXT NOT NULL REFERENCES transcriptions(id) ON DELETE CASCADE,
    page_no          INTEGER NOT NULL,
    text             TEXT,
    image_key        TEXT,
    PRIMARY KEY (transcription_id, page_no)
);

-- =============================================================================
-- Backfill: one document per work that had a PDF
-- =============================================================================
-- SQLite has no uuid(); this is the standard v4 expression. Document ids are
-- new entities referenced by nothing, so generating them here is safe in a way
-- that regenerating a work id would not be.

INSERT INTO documents (
    id, work_id, r2_key, label, page_offset, page_count,
    is_primary, current_transcription_id, created_at, updated_at
)
SELECT
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
    w.id,
    w.pdf_url,
    NULL,
    COALESCE(w.pdf_page_offset, 0),
    NULL,
    1,
    NULL,
    w.created_at,
    w.updated_at
FROM works w
WHERE w.pdf_url IS NOT NULL;

UPDATE works
   SET primary_document_id = (
       SELECT d.id FROM documents d WHERE d.work_id = works.id AND d.is_primary = 1
   )
 WHERE primary_document_id IS NULL;

-- Now that documents own them, a second copy on works could only ever drift.
ALTER TABLE works DROP COLUMN pdf_url;
ALTER TABLE works DROP COLUMN pdf_page_offset;
