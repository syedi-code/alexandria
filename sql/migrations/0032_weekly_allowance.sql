-- Migration: a weekly allowance, and a setting the admin can turn.
--
-- The allowance was a calendar month, and a month is the wrong period to sell.
-- One reader can spend the whole of it in two days and then sit locked out for
-- twenty-eight — which is both the cost and an angry reader, from the same
-- event. A week bounds that to a quarter of the damage in either direction.
--
-- `billing_week` is stored rather than derived for exactly the reason
-- `billing_month` is: `strftime('%Y-%W', created_at)` in a WHERE clause cannot
-- use an index, and this is the question asked on the way into every turn.
-- ISO-8601 weeks, UTC, 'YYYY-Www' — the same shape and the same timezone as
-- the month beside it, so the two can never disagree about when a turn was.
--
-- `billing_month` stays. It is what the spend report and the CLI group by, and
-- an allowance changing period is not a reason to lose the cost record.

ALTER TABLE usage_events ADD COLUMN billing_week TEXT;

-- The quota question, now: turns by this user in this week.
CREATE INDEX IF NOT EXISTS idx_usage_user_week
    ON usage_events(user_id, billing_week, kind);

-- Backfill. SQLite's %W counts weeks from the first Sunday and is not the ISO
-- week, so this is computed the long way: the Thursday of a date's ISO week
-- decides its year and its number, which is the whole of the ISO rule.
UPDATE usage_events
   SET billing_week = (
       WITH d(day) AS (SELECT date(created_at)),
            thu(t) AS (
              SELECT date((SELECT day FROM d),
                          '-' || ((strftime('%w', (SELECT day FROM d)) + 6) % 7)
                                 || ' days',
                          '+3 days')
            )
       SELECT strftime('%Y', (SELECT t FROM thu)) || '-W' ||
              substr('0' || (((strftime('%j', (SELECT t FROM thu)) - 1) / 7) + 1), -2)
   )
 WHERE billing_week IS NULL;

-- Settings the admin turns without a deploy.
--
-- An allowance is a number that has to move — the day the ledger says a tier
-- is underpriced, or a launch goes sideways, waiting on a deploy is waiting
-- too long. An env var is a deploy; a row is not. Values are TEXT so this
-- table never needs migrating to hold the next kind of setting.
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
