-- getShuffleNotes filters latest-version notes with a correlated subquery:
--   NOT EXISTS (SELECT 1 FROM notes r WHERE r.replaces = n.id AND r.user_id = ?)
-- With no ANALYZE statistics the planner resolved that subquery on
-- idx_notes_user, which matches every row in a single-tenant database — so
-- each of N outer rows scanned N inner rows. At 1401 notes that was ~1.25M
-- rows read per shuffle, ~2.5M per GET /notes/shuffle across both queries.
--
-- This composite index covers both subquery terms, so the plan holds
-- regardless of planner statistics. ANALYZE is run alongside it because the
-- database had no sqlite_stat1 at all, leaving every query plan a guess.
CREATE INDEX IF NOT EXISTS idx_notes_replaces_user ON notes(replaces, user_id);

ANALYZE;
