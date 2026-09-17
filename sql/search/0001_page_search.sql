-- The search database: bound to the worker as SEARCH, separate from DB.
--
-- `wrangler d1 export` refuses any database containing a virtual table, and
-- backups are `wrangler d1 export`. So the FTS index lives here, where losing it
-- costs a rebuild and nothing else. Every row is derived from `pages` in the
-- main database; this database is never backed up.

CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(
    document_id UNINDEXED,
    page_no UNINDEXED,
    text,
    tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Which transcription each document's rows were built from, so a rebuild can
-- skip documents that are current and redo those whose text has changed.
CREATE TABLE IF NOT EXISTS indexed_documents (
    document_id       TEXT PRIMARY KEY,
    transcription_id  TEXT NOT NULL,
    page_count        INTEGER NOT NULL,
    indexed_at        TEXT NOT NULL
);
