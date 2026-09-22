import { Hono } from 'hono';
import type Stripe from 'stripe';
import type { Env } from '@alexandria/core/platform';
import {
	failStripeEvent,
	receiveStripeEvent,
	settleStripeEvent,
} from '@alexandria/core/platform';
import { stripeClient } from './client.js';
import { verifyWebhook } from './stripe.js';
import { syncCustomer, syncSubscription, type Synced } from './sync.js';

/**
 * POST /billing/webhook — the only thing that knows a payment happened.
 *
 * Mounted before the session middleware: Stripe sends no cookie, and its
 * signature is what stands in for one. Nothing is read or written before the
 * signature is verified.
 *
 * Every event that concerns a subscription is handled the same way: fetch the
 * subscription from Stripe and copy it across (`syncSubscription`). So the
 * order events arrive in does not matter, a duplicate does nothing new, and
 * an event type not listed here cannot leave a reader on the wrong plan — the
 * next one that is listed puts it right.
 *
 * A failure answers 500, so Stripe retries, for days; an event that cannot be
 * applied (no reader for its customer) answers 200 and is logged with why,
 * because retrying it would fail the same way for as long as Stripe tried.
 */
const app = new Hono<{ Bindings: Env }>();

type Handled = { synced: Synced[] } | { ignored: true };

const idOf = (value: string | { id: string } | null | undefined) =>
	typeof value === 'string' ? value : (value?.id ?? null);

/** The subscription an invoice bills, wherever this API version keeps it. */
function invoiceSubscription(invoice: Stripe.Invoice): string | null {
	return idOf(invoice.parent?.subscription_details?.subscription);
}

async function handle(
	env: Env,
	stripe: Stripe,
	event: Stripe.Event
): Promise<Handled> {
	switch (event.type) {
		case 'checkout.session.completed':
		case 'checkout.session.async_payment_succeeded': {
			const session = event.data.object;
			const subscription = idOf(session.subscription);
			if (session.mode !== 'subscription' || !subscription) {
				return { ignored: true };
			}
			return {
				synced: [
					await syncSubscription(
						env,
						stripe,
						subscription,
						session.client_reference_id
					),
				],
			};
		}
		case 'customer.subscription.created':
		case 'customer.subscription.updated':
		case 'customer.subscription.deleted':
		case 'customer.subscription.paused':
		case 'customer.subscription.resumed':
			return {
				synced: [
					await syncSubscription(env, stripe, event.data.object.id),
				],
			};
		case 'invoice.paid':
		case 'invoice.payment_failed': {
			const subscription = invoiceSubscription(event.data.object);
			return subscription
				? {
						synced: [
							await syncSubscription(env, stripe, subscription),
						],
					}
				: { ignored: true };
		}
		case 'customer.deleted':
			return {
				synced: await syncCustomer(env, stripe, event.data.object.id),
			};
		default:
			return { ignored: true };
	}
}

app.post('/billing/webhook', async (c) => {
	const signature = c.req.header('stripe-signature');
	if (
		!signature ||
		!c.env.STRIPE_WEBHOOK_SECRET ||
		!c.env.STRIPE_SECRET_KEY
	) {
		return c.json({ error: 'Not a Stripe webhook' }, 400);
	}

	let event: Stripe.Event;
	try {
		event = await verifyWebhook(c.env, await c.req.text(), signature);
	} catch {
		return c.json({ error: 'Signature did not verify' }, 400);
	}

	const { fresh } = await receiveStripeEvent(c.env.DB, event);
	if (!fresh) return c.json({ received: true, duplicate: true });

	try {
		const handled = await handle(c.env, stripeClient(c.env), event);
		const failures =
			'synced' in handled
				? handled.synced.flatMap((s) =>
						'reason' in s ? [s.reason] : []
					)
				: [];
		await settleStripeEvent(c.env.DB, event.id, {
			error: failures.length ? failures.join('; ') : undefined,
		});
		if (failures.length) {
			console.error(
				'[billing] event applied with gaps',
				event.id,
				failures
			);
		}
		return c.json({ received: true });
	} catch (error) {
		console.error('[billing] event failed', event.id, event.type, error);
		await failStripeEvent(c.env.DB, event.id, String(error));
		return c.json({ error: 'Could not apply the event' }, 500);
	}
});

export default app;
