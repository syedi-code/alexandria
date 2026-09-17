-- D1 Schema: Polymorphic connections table
-- Enables any entity to link to any other entity via typed edges.
-- Convention: a_type <= b_type alphabetically (enforced in application code).

CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    a_type TEXT NOT NULL,
    a_id TEXT NOT NULL,
    b_type TEXT NOT NULL,
    b_id TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connections_a ON connections(a_type, a_id);
CREATE INDEX IF NOT EXISTS idx_connections_b ON connections(b_type, b_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_unique ON connections(a_type, a_id, b_type, b_id);
