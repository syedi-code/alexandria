-- Migration: Add book_media table
-- Each book may have any number of attached visual media (images).
-- Distinct from books.cover_url, which remains the dedicated cover used
-- by the essay book-cover slide kind. book_media is the unbounded gallery
-- surfaced in the library detail pane.

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
