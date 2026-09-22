/// <reference types="@cloudflare/workers-types" />
import type { UserPlan } from './schema.js';

/**
 * What the worker knows about the money, and nothing it has to trust anyone
 * for. Stripe is the record; this is a copy of the part a turn needs, kept so
 * that it can only ever agree with Stripe's latest word.
 */

/**
 * The statuses that keep Paid on. `past_due` is among them: Stripe is retrying
 * the card, the reader has not been told no, and cutting them off mid-retry
 * would punish a bank's decline as though it were theirs. Stripe cancels the
 * subscription if the retries fail, and that is when Paid ends.
 */
export const PAYING_STATUSES = ['active', 'trialing', 'past_due'] as const;

export interface SubscriptionRecord {
	id: string;
	user_id: string;
	customer_id: string;
	status: string;
	price_id: string | null;
	/** When it renews, ISO. */
	current_period_end: string | null;
	/** When it ends, ISO, once it has been cancelled to end. */
	cancel_at: string | null;
}

const paying = PAYING_STATUSES.map(() => '?').join(', ');

/**
 * Record what Stripe last said about one subscription, and recompute the
 * reader's plan from every subscription they hold, in one batch.
 *
 * The plan is derived, never set: a reader is on Paid exactly when one of
 * their subscriptions is in a paying status. So recording the same thing twice
 * is the same as recording it once, and recording an old state after a new one
 * is harmless as long as the caller fetched what it records — which the
 * webhook does, from Stripe, every time.
 */
export async function recordSubscription(
	db: D1Database,
	record: SubscriptionRecord,
	at: string = new Date().toISOString()
): Promise<UserPlan> {
	await db.batch([
		db
			.prepare(
				`INSERT INTO subscriptions
				   (id, user_id, customer_id, status, price_id,
				    current_period_end, cancel_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   status = excluded.status,
				   price_id = excluded.price_id,
				   current_period_end = excluded.current_period_end,
				   cancel_at = excluded.cancel_at,
				   updated_at = excluded.updated_at`
			)
			.bind(
				record.id,
				record.user_id,
				record.customer_id,
				record.status,
				record.price_id,
				record.current_period_end,
				record.cancel_at,
				at,
				at
			),
		recomputePlan(db, record.user_id),
	]);
	return planOf(db, record.user_id);
}

function recomputePlan(db: D1Database, userId: string) {
	return db
		.prepare(
			`UPDATE users SET plan = CASE WHEN EXISTS (
			   SELECT 1 FROM subscriptions
			    WHERE user_id = ? AND status IN (${paying})
			 ) THEN 'paid' ELSE 'free' END
			 WHERE id = ?`
		)
		.bind(userId, ...PAYING_STATUSES, userId);
}

async function planOf(db: D1Database, userId: string): Promise<UserPlan> {
	const row = await db
		.prepare(`SELECT plan FROM users WHERE id = ?`)
		.bind(userId)
		.first<{ plan: UserPlan }>();
	return row?.plan ?? 'free';
}

export async function userIdForCustomer(
	db: D1Database,
	customerId: string
): Promise<string | null> {
	const row = await db
		.prepare(`SELECT id FROM users WHERE stripe_customer_id = ?`)
		.bind(customerId)
		.first<{ id: string }>();
	return row?.id ?? null;
}

export async function customerIdForUser(
	db: D1Database,
	userId: string
): Promise<string | null> {
	const row = await db
		.prepare(`SELECT stripe_customer_id FROM users WHERE id = ?`)
		.bind(userId)
		.first<{ stripe_customer_id: string | null }>();
	return row?.stripe_customer_id ?? null;
}

/**
 * Tie a Stripe customer to a reader, once. Returns the customer the reader is
 * tied to afterwards, which is the one passed in unless another got there
 * first — two checkouts started at once must not leave a reader with two
 * customers and a webhook that knows only one of them.
 */
export async function claimCustomer(
	db: D1Database,
	userId: string,
	customerId: string
): Promise<string | null> {
	await db
		.prepare(
			`UPDATE users SET stripe_customer_id = ?
			  WHERE id = ? AND stripe_customer_id IS NULL
			    AND NOT EXISTS (SELECT 1 FROM users WHERE stripe_customer_id = ?)`
		)
		.bind(customerId, userId, customerId)
		.run();
	return customerIdForUser(db, userId);
}

export interface Billing {
	plan: UserPlan;
	/** Whether there is a Stripe customer to manage, and so a portal to open. */
	manageable: boolean;
	/** The subscription that keeps Paid on, if there is one. */
	subscription: {
		status: string;
		renews_at: string | null;
		ends_at: string | null;
	} | null;
}

/** What the account sheet says about billing, from what is already here. */
export async function billingFor(
	db: D1Database,
	userId: string
): Promise<Billing> {
	const [user, subscription] = await Promise.all([
		db
			.prepare(`SELECT plan, stripe_customer_id FROM users WHERE id = ?`)
			.bind(userId)
			.first<{ plan: UserPlan; stripe_customer_id: string | null }>(),
		db
			.prepare(
				`SELECT status, current_period_end, cancel_at FROM subscriptions
				  WHERE user_id = ? AND status IN (${paying})
				  ORDER BY updated_at DESC LIMIT 1`
			)
			.bind(userId, ...PAYING_STATUSES)
			.first<{
				status: string;
				current_period_end: string | null;
				cancel_at: string | null;
			}>(),
	]);
	return {
		plan: user?.plan ?? 'free',
		manageable: Boolean(user?.stripe_customer_id),
		subscription: subscription
			? {
					status: subscription.status,
					renews_at: subscription.cancel_at
						? null
						: subscription.current_period_end,
					ends_at: subscription.cancel_at,
				}
			: null,
	};
}

/**
 * Note a webhook as received. `fresh` is false only for an event already
 * handled to the end; one that failed part-way is handled again, which is safe
 * because handling re-reads Stripe rather than the event.
 */
export async function receiveStripeEvent(
	db: D1Database,
	event: { id: string; type: string },
	at: string = new Date().toISOString()
): Promise<{ fresh: boolean }> {
	await db
		.prepare(
			`INSERT INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)
			 ON CONFLICT(id) DO NOTHING`
		)
		.bind(event.id, event.type, at)
		.run();
	const row = await db
		.prepare(`SELECT processed_at FROM stripe_events WHERE id = ?`)
		.bind(event.id)
		.first<{ processed_at: string | null }>();
	return { fresh: !row?.processed_at };
}

/** Close an event: handled, or handled with a note of what did not add up. */
export async function settleStripeEvent(
	db: D1Database,
	id: string,
	outcome: { error?: string } = {},
	at: string = new Date().toISOString()
): Promise<void> {
	await db
		.prepare(
			`UPDATE stripe_events SET processed_at = ?, error = ? WHERE id = ?`
		)
		.bind(at, outcome.error ?? null, id)
		.run();
}

/** An event that failed and will be retried: kept open, with why. */
export async function failStripeEvent(
	db: D1Database,
	id: string,
	error: string
): Promise<void> {
	await db
		.prepare(`UPDATE stripe_events SET error = ? WHERE id = ?`)
		.bind(error.slice(0, 1000), id)
		.run();
}
