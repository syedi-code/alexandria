-- Migration: billing.
--
-- Stripe owns the money; this is what the worker needs to know about it.
--
-- `users.plan` stays the entitlement: it is what every turn reads, in the one
-- query it already makes. It is no longer set by hand. It is recomputed from
-- `subscriptions` every time a subscription changes, so it can never disagree
-- with the rows beside it, and a webhook that arrives twice, or late, or before
-- the one it followed, recomputes the same answer.
--
-- `subscriptions` holds what Stripe last said, fetched from Stripe rather than
-- read off an event: events arrive in any order, and the subscription itself
-- is the only thing that is always current.
--
-- `stripe_events` is the log of every webhook received, and what makes a
-- delivery that has already been handled a no-op.
--
-- Nothing here is ever deleted by the conversation pruning job: these rows are
-- the billing record.

ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;

-- One Stripe customer per reader, and one reader per customer: the webhook
-- finds the reader by the customer, so two readers sharing one would be one
-- paying for the other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer
    ON users(stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscriptions (
    id                  TEXT PRIMARY KEY,       -- Stripe's sub_…
    user_id             TEXT NOT NULL REFERENCES users(id),
    customer_id         TEXT NOT NULL,
    status              TEXT NOT NULL,          -- Stripe's, verbatim
    price_id            TEXT,
    current_period_end  TEXT,                   -- ISO; when it renews
    cancel_at           TEXT,                   -- ISO; when it ends, if it will
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

CREATE TABLE IF NOT EXISTS stripe_events (
    id            TEXT PRIMARY KEY,             -- Stripe's evt_…
    type          TEXT NOT NULL,
    received_at   TEXT NOT NULL,
    processed_at  TEXT,
    error         TEXT
);
