import type Stripe from 'stripe';
import type { Env, UserPlan } from '@alexandria/core/platform';
import {
	claimCustomer,
	getUserById,
	recordSubscription,
	userIdForCustomer,
} from '@alexandria/core/platform';

const iso = (seconds: number | null | undefined) =>
	seconds ? new Date(seconds * 1000).toISOString() : null;

const idOf = (value: string | { id: string } | null | undefined) =>
	typeof value === 'string' ? value : (value?.id ?? null);

/** What came of copying one subscription across. */
export type Synced =
	| { ok: true; user_id: string; plan: UserPlan }
	| { ok: false; reason: string };

/**
 * Copy one subscription from Stripe into `subscriptions`, and the plan with
 * it. Always fetched, never read off the event that prompted it: events come
 * in any order and more than once, and the subscription as Stripe holds it now
 * is the only version that is never stale.
 *
 * The reader is found by the customer, which is tied to them when checkout
 * makes it. `hint` — the reader checkout was started for — and the
 * subscription's own `metadata.user_id` are used only to tie a customer that
 * is not tied yet, and never to move one from one reader to another.
 */
export async function syncSubscription(
	env: Env,
	stripe: Stripe,
	subscriptionId: string,
	hint: string | null = null
): Promise<Synced> {
	const subscription = await stripe.subscriptions.retrieve(subscriptionId);
	const customerId = idOf(subscription.customer);
	if (!customerId)
		return { ok: false, reason: 'subscription has no customer' };

	let userId = await userIdForCustomer(env.DB, customerId);
	if (!userId) {
		const claimant = hint ?? subscription.metadata?.user_id ?? null;
		if (!claimant || !(await getUserById(env.DB, claimant))) {
			return {
				ok: false,
				reason: `no reader for customer ${customerId}`,
			};
		}
		const tied = await claimCustomer(env.DB, claimant, customerId);
		if (tied !== customerId) {
			return {
				ok: false,
				reason: `reader ${claimant} is tied to another customer`,
			};
		}
		userId = claimant;
	}

	const item = subscription.items.data[0];
	const periodEnd = iso(item?.current_period_end);
	const plan = await recordSubscription(env.DB, {
		id: subscription.id,
		user_id: userId,
		customer_id: customerId,
		status: subscription.status,
		price_id: item?.price.id ?? null,
		current_period_end: periodEnd,
		cancel_at:
			iso(subscription.cancel_at) ??
			(subscription.cancel_at_period_end ? periodEnd : null),
	});
	return { ok: true, user_id: userId, plan };
}

/** Every subscription a customer holds, copied across. */
export async function syncCustomer(
	env: Env,
	stripe: Stripe,
	customerId: string,
	hint: string | null = null
): Promise<Synced[]> {
	const { data } = await stripe.subscriptions.list({
		customer: customerId,
		status: 'all',
		limit: 20,
	});
	const results: Synced[] = [];
	for (const subscription of data) {
		results.push(
			await syncSubscription(env, stripe, subscription.id, hint)
		);
	}
	return results;
}
