#!/usr/bin/env tsx
/**
 * Everything Stripe needs to sell Paid, made by a script rather than by
 * clicking: a price made in a dashboard exists in one account and nobody can
 * say how it was configured, and this can be read, reviewed and run again.
 *
 *   STRIPE_SECRET_KEY=sk_test_… npm run stripe:setup
 *   STRIPE_SECRET_KEY=sk_live_… npm run stripe:setup -- --live
 *   … -- --webhook-url https://antisocial-worker-staging.….workers.dev/api/billing/webhook
 *
 * Test mode and live mode are separate accounts as far as Stripe is
 * concerned, so each gets its own product, price, portal and endpoint. The
 * endpoint defaults to production's; before launch, while the only reader is
 * the admin, production can run on a test key and take 4242 cards.
 *
 * Safe to run twice. It finds what an earlier run made (by lookup key, by
 * metadata, by URL) and makes only what is missing. It never deletes and
 * never changes a price: a price is fixed once someone has paid it, so a new
 * figure is a new Price, and the lookup key moves to it.
 *
 * It prints the two values to put in the worker's secrets: the webhook
 * signing secret (only on the run that creates the endpoint — Stripe shows it
 * once) and the portal configuration.
 */
import Stripe from 'stripe';

function argument(name: string): string | undefined {
	const at = process.argv.indexOf(name);
	return at === -1 ? undefined : process.argv[at + 1];
}

const PRODUCT_TAG = 'scribe_paid';
const LOOKUP_KEY = 'scribe_paid_monthly';
const AMOUNT_CENTS = 2000;
const CURRENCY = 'usd';
const WEBHOOK_URL =
	argument('--webhook-url') ??
	'https://alexandria.socialeating.studio/api/billing/webhook';
const RETURN_URL = 'https://scribe.socialeating.studio/';
const TERMS_URL = 'https://scribe.socialeating.studio/legal/terms.html';
const PRIVACY_URL = 'https://scribe.socialeating.studio/legal/privacy.html';

/** What the webhook acts on; see apps/worker/api/billing/webhook.ts. */
const EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
	'checkout.session.completed',
	'checkout.session.async_payment_succeeded',
	'customer.subscription.created',
	'customer.subscription.updated',
	'customer.subscription.deleted',
	'customer.subscription.paused',
	'customer.subscription.resumed',
	'invoice.paid',
	'invoice.payment_failed',
	'customer.deleted',
];

const key = process.env.STRIPE_SECRET_KEY;
const live = process.argv.includes('--live');

if (!key) {
	console.error('Set STRIPE_SECRET_KEY first.');
	process.exit(1);
}
if (key.startsWith('sk_live_') !== live) {
	console.error(
		live
			? '--live was given with a test key. Refusing.'
			: 'That is a live key. Run again with --live if you mean it.'
	);
	process.exit(1);
}

const stripe = new Stripe(key);
const say = (what: string, detail = '') =>
	console.log(`  ${what.padEnd(22)} ${detail}`);

async function product(): Promise<Stripe.Product> {
	const { data } = await stripe.products.search({
		query: `metadata['tag']:'${PRODUCT_TAG}' AND active:'true'`,
	});
	if (data[0]) {
		say('product', `${data[0].id} (kept)`);
		return data[0];
	}
	const made = await stripe.products.create({
		name: 'Scribe Paid',
		description:
			'150 questions a month, Claude Sonnet 5 by default, and the scanned page behind every quotation.',
		metadata: { tag: PRODUCT_TAG },
		statement_descriptor: 'SCRIBE',
	});
	say('product', `${made.id} (made)`);
	return made;
}

async function price(productId: string): Promise<Stripe.Price> {
	const { data } = await stripe.prices.list({
		lookup_keys: [LOOKUP_KEY],
		active: true,
		limit: 1,
	});
	const current = data[0];
	if (
		current &&
		current.unit_amount === AMOUNT_CENTS &&
		current.currency === CURRENCY &&
		current.recurring?.interval === 'month'
	) {
		say('price', `${current.id} (kept)`);
		return current;
	}
	const made = await stripe.prices.create({
		product: productId,
		unit_amount: AMOUNT_CENTS,
		currency: CURRENCY,
		recurring: { interval: 'month' },
		lookup_key: LOOKUP_KEY,
		// Takes the key from the old price, if there was one; the old price
		// keeps billing whoever is already on it.
		transfer_lookup_key: true,
		tax_behavior: 'exclusive',
	});
	say(
		'price',
		`${made.id} (made${current ? `, replacing ${current.id}` : ''})`
	);
	return made;
}

async function portal(productId: string, priceId: string) {
	const { data } = await stripe.billingPortal.configurations.list({
		active: true,
		limit: 100,
	});
	const ours = data.find((c) => c.metadata?.tag === PRODUCT_TAG);
	if (ours) {
		say('portal', `${ours.id} (kept)`);
		return ours;
	}
	const made = await stripe.billingPortal.configurations.create({
		metadata: { tag: PRODUCT_TAG },
		business_profile: {
			headline: 'Scribe — your plan',
			terms_of_service_url: TERMS_URL,
			privacy_policy_url: PRIVACY_URL,
		},
		default_return_url: RETURN_URL,
		features: {
			// Cancelling ends at the period's end: what was paid for is kept.
			subscription_cancel: {
				enabled: true,
				mode: 'at_period_end',
				cancellation_reason: {
					enabled: true,
					options: [
						'too_expensive',
						'unused',
						'missing_features',
						'other',
					],
				},
			},
			payment_method_update: { enabled: true },
			invoice_history: { enabled: true },
			customer_update: {
				enabled: true,
				allowed_updates: ['email', 'address'],
			},
			subscription_update: {
				enabled: false,
				default_allowed_updates: [],
				products: [{ product: productId, prices: [priceId] }],
			},
		},
	});
	say('portal', `${made.id} (made)`);
	return made;
}

async function webhook() {
	const { data } = await stripe.webhookEndpoints.list({ limit: 100 });
	const ours = data.find((e) => e.url === WEBHOOK_URL);
	if (ours) {
		const missing = EVENTS.filter(
			(e) =>
				!ours.enabled_events.includes(e) &&
				!ours.enabled_events.includes('*')
		);
		if (missing.length) {
			await stripe.webhookEndpoints.update(ours.id, {
				enabled_events: EVENTS,
			});
			say('webhook', `${ours.id} (events brought up to date)`);
		} else {
			say(
				'webhook',
				`${ours.id} (kept; its secret was shown when it was made)`
			);
		}
		return null;
	}
	const made = await stripe.webhookEndpoints.create({
		url: WEBHOOK_URL,
		enabled_events: EVENTS,
		description: 'alexandria: the plan a reader is on',
	});
	say('webhook', `${made.id} (made)`);
	return made.secret ?? null;
}

console.log(
	`\nStripe, ${live ? 'LIVE' : 'test'} mode, webhook to ${WEBHOOK_URL}\n`
);
const made = await product();
const onSale = await price(made.id);
const configuration = await portal(made.id, onSale.id);
const secret = await webhook();

const env = WEBHOOK_URL.includes('staging') ? ' --env staging' : '';
console.log('\nPut these in the worker:\n');
if (secret) {
	console.log(
		`  npx wrangler secret put STRIPE_WEBHOOK_SECRET${env}   # ${secret}`
	);
}
console.log(
	`  npx wrangler secret put STRIPE_PORTAL_CONFIGURATION${env}   # ${configuration.id}`
);
console.log(
	`  npx wrangler secret put STRIPE_SECRET_KEY${env}   # the key you ran this with\n`
);
