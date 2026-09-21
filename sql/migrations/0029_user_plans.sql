-- Migration: users.plan.
--
-- Two tiers, so a column rather than a table: a `plans` table of two rows buys
-- nothing but a join, and the column is the whole of the entitlement model
-- until there is a third tier.
--
-- Not the same axis as `role`. Role is computed at runtime from ADMIN_EMAIL and
-- says who may administer the library; plan says how much of it a reader may
-- spend. The admin is not on a plan — the bill is already theirs.

ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'paid'));

-- Every existing row takes the default. Nobody has paid yet, and the admin is
-- exempt by role rather than by plan, so there is nothing to backfill.
