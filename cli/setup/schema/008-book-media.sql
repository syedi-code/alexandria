-- D1 Schema: Book Media (visual attachments for books)
-- Distinct from books.cover_url. Surfaces in the library detail pane.

CREATE TABLE IF NOT EXISTS book_media (
    id          TEXT PRIMARY KEY,
    book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id),
    path        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'image',
    caption     TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_book_media_book ON book_media(book_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_book_media_user ON book_media(user_id);
