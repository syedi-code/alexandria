-- Migration: guests.
--
-- A visitor may ask three questions before signing in (scribe#38). A guest is
-- an ordinary `users` row with `is_guest = 1` and an ordinary session, so
-- everything downstream of the session — the chat route, the ledger, the
-- limit — works for a guest unchanged, and signing in moves the guest's rows
-- to the real account in one batch.
--
-- Only added columns and one table: `users.email` is NOT NULL UNIQUE and
-- `sessions.role` has a CHECK, and changing either in SQLite means rebuilding
-- a table about ten others reference. A guest takes a placeholder address
-- (`guest-<id>@guest.invalid`, a domain reserved never to resolve) and the
-- role `member`; guest status is this column and nothing else.

ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0;

-- The cleanup job's question: guests nobody has used in 30 days.
CREATE INDEX IF NOT EXISTS idx_users_guests
    ON users(first_seen)
    WHERE is_guest = 1;

-- How many guests each address has made today, for the per-address cap.
-- The address is never stored: `ip_hash` is an HMAC of it under a secret the
-- database does not hold, so the table cannot be read back into addresses.
CREATE TABLE IF NOT EXISTS guest_ips (
    ip_hash  TEXT NOT NULL,
    day      TEXT NOT NULL,                 -- 'YYYY-MM-DD', UTC
    count    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ip_hash, day)
);
