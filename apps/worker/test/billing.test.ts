import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Stripe from 'stripe';
import {
	migratedTestDatabase,
	type TestDatabase,
} from '../../../packages/core/test/d1.js';

/**
 * Billing, end to end through the router: checkout, the webhook, the portal
 * and the plan they decide.
 *
 * Stripe's API is a fake held in memory (`FakeStripe`), because a test that
 * needs the network is a test nobody runs. Stripe's *signatures* are real: the
 * events below are signed with the Stripe library's own test helper and
 * checked by the same `constructEventAsync` production runs, so a webhook that
 * passes here has passed the real verifier.
 */

const WEBHOOK_SECRET = 'whsec_test_secret';
const NOW = Math.floor(Date.now() / 1000);
const MONTH = 30 * 24 * 3600;

interface FakeSubscription {
	id: string;
	customer: string;
	status: Stripe.Subscription.Status;
	metadata: Record<string, string>;
	cancel_at: number | null;
	cancel_at_period_end: boolean;
	items: {
		data: { current_period_end: number; price: { id: string } }[];
	};
}

/** The part of Stripe these routes use, with what was asked of it recorded. */
class FakeStripe {
	customers = new Map<
		string,
		{ id: string; email: string; metadata: object }
	>();
	subscriptions = new Map<string, FakeSubscription>();
	sessions: Stripe.Checkout.SessionCreateParams[] = [];
	portals: Stripe.BillingPortal.SessionCreateParams[] = [];
	retrieved: string[] = [];
	idempotent = new Map<string, string>();
	down = false;
	prices = [
		{
			id: 'price_paid',
			lookup_key: 'scribe_paid_monthly',
			unit_amount: 2000,
			currency: 'usd',
			recurring: { interval: 'month' },
		},
	];

	private guard() {
		if (this.down) throw new Error('Stripe is unreachable');
	}

	subscribe(
		customer: string,
		status: Stripe.Subscription.Status = 'active',
		over: Partial<FakeSubscription> = {}
	): FakeSubscription {
		const id = `sub_${this.subscriptions.size + 1}`;
		const subscription: FakeSubscription = {
			id,
			customer,
			status,
			metadata: {},
			cancel_at: null,
			cancel_at_period_end: false,
			items: {
				data: [
					{
						current_period_end: NOW + MONTH,
						price: { id: 'price_paid' },
					},
				],
			},
			...over,
		};
		this.subscriptions.set(id, subscription);
		return subscription;
	}

	client = {
		customers: {
			create: async (
				params: { email: string; metadata: object },
				options?: { idempotencyKey?: string }
			) => {
				this.guard();
				const key = options?.idempotencyKey;
				if (key && this.idempotent.has(key)) {
					return this.customers.get(this.idempotent.get(key)!)!;
				}
				const customer = {
					id: `cus_${this.customers.size + 1}`,
					...params,
				};
				this.customers.set(customer.id, customer);
				if (key) this.idempotent.set(key, customer.id);
				return customer;
			},
		},
		subscriptions: {
			retrieve: async (id: string) => {
				this.guard();
				this.retrieved.push(id);
				const subscription = this.subscriptions.get(id);
				if (!subscription)
					throw new Error(`No such subscription: ${id}`);
				return structuredClone(subscription);
			},
			list: async ({ customer }: { customer: string }) => {
				this.guard();
				return {
					data: [...this.subscriptions.values()].filter(
						(s) => s.customer === customer
					),
				};
			},
		},
		prices: {
			list: async ({ lookup_keys }: { lookup_keys: string[] }) => {
				this.guard();
				return {
					data: this.prices.filter((p) =>
						lookup_keys.includes(p.lookup_key)
					),
				};
			},
		},
		checkout: {
			sessions: {
				create: async (params: Stripe.Checkout.SessionCreateParams) => {
					this.guard();
					this.sessions.push(params);
					return {
						id: 'cs_1',
						url: 'https://checkout.stripe.test/cs_1',
					};
				},
			},
		},
		billingPortal: {
			sessions: {
				create: async (
					params: Stripe.BillingPortal.SessionCreateParams
				) => {
					this.guard();
					this.portals.push(params);
					return { url: 'https://billing.stripe.test/p_1' };
				},
			},
		},
	};
}

let stripe: FakeStripe;

vi.mock('../api/billing/client.js', () => ({
	stripeClient: () => stripe.client,
}));

const { default: router } = await import('../api/router.js');
const { forgetPrice } = await import('../api/billing/stripe.js');

let db: TestDatabase;
const AT = '2026-09-01T00:00:00Z';

function seedReader(id: string, role: 'member' | 'admin' = 'member') {
	db.raw
		.prepare(
			`INSERT INTO users (id, email, first_seen, last_seen) VALUES (?, ?, ?, ?)`
		)
		.run(id, `${id}@readers.test`, AT, AT);
	db.raw
		.prepare(
			`INSERT INTO sessions (token, user_id, email, role, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(
			`t-${id}`,
			id,
			`${id}@readers.test`,
			role,
			AT,
			'2099-01-01T00:00:00Z'
		);
}

beforeEach(() => {
	db = migratedTestDatabase();
	stripe = new FakeStripe();
	forgetPrice();
	seedReader('ada');
	seedReader('ben');
	seedReader('root', 'admin');
});

afterEach(() => db.close());

const ENV = () => ({
	DB: db.d1,
	ADMIN_EMAIL: 'root@readers.test',
	LOCAL_DEV: 'false',
	STRIPE_SECRET_KEY: 'sk_test_fake',
	STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
	OPENAI_API_KEY: 'k',
	ANTHROPIC_API_KEY: 'k',
});

const call = (
	path: string,
	reader: string | null,
	init: RequestInit = {},
	env: Record<string, unknown> = ENV()
) =>
	router.fetch(
		new Request(`http://alexandria.test${path}`, {
			...init,
			headers: {
				...(reader ? { cookie: `__session=t-${reader}` } : {}),
				...(init.headers as Record<string, string>),
			},
		}),
		env
	);

const signer = new Stripe('sk_test_signer');

/** An event as Stripe would send it, signed for this endpoint. */
async function deliver(
	type: string,
	object: object,
	{
		id = `evt_${Math.random().toString(36).slice(2)}`,
		timestamp,
		secret = WEBHOOK_SECRET,
	}: { id?: string; timestamp?: number; secret?: string } = {}
) {
	const payload = JSON.stringify({
		id,
		object: 'event',
		type,
		created: NOW,
		data: { object },
	});
	const signature = await signer.webhooks.generateTestHeaderStringAsync({
		payload,
		secret,
		timestamp,
		cryptoProvider: Stripe.createSubtleCryptoProvider(),
	});
	return call('/billing/webhook', null, {
		method: 'POST',
		body: payload,
		headers: {
			'stripe-signature': signature,
			'content-type': 'application/json',
		},
	});
}

const planOf = (id: string) =>
	(
		db.raw.prepare(`SELECT plan FROM users WHERE id = ?`).get(id) as {
			plan: string;
		}
	).plan;

const customerOf = (id: string) =>
	(
		db.raw
			.prepare(`SELECT stripe_customer_id AS c FROM users WHERE id = ?`)
			.get(id) as { c: string | null }
	).c;

const events = () =>
	db.raw
		.prepare(`SELECT * FROM stripe_events ORDER BY received_at`)
		.all() as {
		id: string;
		processed_at: string | null;
		error: string | null;
	}[];

const checkout = (reader: string) =>
	call(`/billing/checkout`, reader, { method: 'POST' });

/** A reader who has been through checkout, with the customer it made. */
async function checkedOut(reader: string) {
	expect((await checkout(reader)).status).toBe(200);
	return customerOf(reader)!;
}

const completed = (reader: string, subscription: FakeSubscription) =>
	deliver('checkout.session.completed', {
		id: 'cs_1',
		object: 'checkout.session',
		mode: 'subscription',
		client_reference_id: reader,
		customer: subscription.customer,
		subscription: subscription.id,
	});

describe('POST /billing/checkout', () => {
	it('opens a Stripe page for Paid, tied to the reader', async () => {
		const response = await checkout('ada');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			url: 'https://checkout.stripe.test/cs_1',
		});

		const [session] = stripe.sessions;
		expect(session).toMatchObject({
			mode: 'subscription',
			customer: customerOf('ada'),
			client_reference_id: 'ada',
			line_items: [{ price: 'price_paid', quantity: 1 }],
			subscription_data: { metadata: { user_id: 'ada' } },
			success_url: 'https://scribe.socialeating.studio/?checkout=done',
			cancel_url:
				'https://scribe.socialeating.studio/?checkout=cancelled',
		});
		// Opening checkout is not paying.
		expect(planOf('ada')).toBe('free');
	});

	it('makes one customer however many times it is pressed', async () => {
		await Promise.all([checkout('ada'), checkout('ada'), checkout('ada')]);
		await checkout('ada');
		expect(stripe.customers.size).toBe(1);
		expect(new Set(stripe.sessions.map((s) => s.customer)).size).toBe(1);
	});

	it('gives each reader a customer of their own', async () => {
		await checkout('ada');
		await checkout('ben');
		expect(customerOf('ada')).not.toBe(customerOf('ben'));
	});

	it('refuses a reader already on Paid', async () => {
		const customer = await checkedOut('ada');
		await completed('ada', stripe.subscribe(customer));
		stripe.sessions.length = 0;

		const response = await checkout('ada');
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ code: 'ALREADY_PAID' });
		expect(stripe.sessions).toHaveLength(0);
	});

	// The webhook is late and the reader presses again: Stripe already holds a
	// live subscription, and a second checkout would bill them twice.
	it('will not bill twice when the webhook has not arrived yet', async () => {
		const customer = await checkedOut('ada');
		stripe.subscribe(customer);
		stripe.sessions.length = 0;

		const response = await checkout('ada');
		expect(response.status).toBe(409);
		expect(stripe.sessions).toHaveLength(0);
		// And the check put the plan right while it was there.
		expect(planOf('ada')).toBe('paid');
	});

	it('has nothing to sell the admin', async () => {
		const response = await checkout('root');
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code: 'ALREADY_UNLIMITED',
		});
	});

	it('says checkout is closed when there is no key, or no price on sale', async () => {
		const { STRIPE_SECRET_KEY: _, ...keyless } = ENV();
		expect(
			(
				await call(
					'/billing/checkout',
					'ada',
					{ method: 'POST' },
					keyless
				)
			).status
		).toBe(501);

		stripe.prices = [];
		const response = await checkout('ada');
		expect(response.status).toBe(501);
		expect(await response.json()).toMatchObject({
			code: 'CHECKOUT_NOT_OPEN',
		});
	});

	it('needs a session', async () => {
		expect(
			(await call('/billing/checkout', null, { method: 'POST' })).status
		).toBe(401);
	});
});

describe('POST /billing/webhook, before anything is believed', () => {
	it('refuses a body that is not signed by Stripe, and writes nothing', async () => {
		const forged = await deliver(
			'customer.subscription.created',
			{ id: 'sub_x' },
			{ secret: 'whsec_someone_else' }
		);
		expect(forged.status).toBe(400);

		const unsigned = await call('/billing/webhook', null, {
			method: 'POST',
			body: JSON.stringify({
				id: 'evt_x',
				type: 'checkout.session.completed',
			}),
		});
		expect(unsigned.status).toBe(400);

		expect(events()).toEqual([]);
		expect(stripe.retrieved).toEqual([]);
	});

	it('refuses a signed event replayed long after it was sent', async () => {
		const stale = await deliver(
			'customer.subscription.created',
			{ id: 'sub_x' },
			{ timestamp: NOW - 60 * 60 }
		);
		expect(stale.status).toBe(400);
		expect(events()).toEqual([]);
	});

	it('refuses everything when the endpoint has no secret set', async () => {
		const { STRIPE_WEBHOOK_SECRET: _, ...unset } = ENV();
		const response = await call(
			'/billing/webhook',
			null,
			{
				method: 'POST',
				body: '{}',
				headers: { 'stripe-signature': 't=1,v1=x' },
			},
			unset
		);
		expect(response.status).toBe(400);
	});
});

describe('the plan the webhook decides', () => {
	it('turns Paid on when checkout completes', async () => {
		const customer = await checkedOut('ada');
		const response = await completed('ada', stripe.subscribe(customer));

		expect(response.status).toBe(200);
		expect(planOf('ada')).toBe('paid');
		expect(events()[0]).toMatchObject({ error: null });
		expect(events()[0].processed_at).not.toBeNull();
	});

	it('does a duplicate delivery once', async () => {
		const customer = await checkedOut('ada');
		const subscription = stripe.subscribe(customer);
		const first = await deliver(
			'customer.subscription.created',
			subscription,
			{
				id: 'evt_same',
			}
		);
		const again = await deliver(
			'customer.subscription.created',
			subscription,
			{
				id: 'evt_same',
			}
		);

		expect(first.status).toBe(200);
		expect(await again.json()).toMatchObject({ duplicate: true });
		expect(stripe.retrieved).toEqual([subscription.id]);
		expect(events()).toHaveLength(1);
	});

	// Events arrive in any order. What is copied is Stripe's current word, so
	// a creation delivered after the cancellation cannot bring Paid back.
	it('is not fooled by an old event arriving late', async () => {
		const customer = await checkedOut('ada');
		const subscription = stripe.subscribe(customer);
		const created = structuredClone(subscription);

		subscription.status = 'canceled';
		await deliver('customer.subscription.deleted', subscription);
		expect(planOf('ada')).toBe('free');

		await deliver('customer.subscription.created', created);
		expect(planOf('ada')).toBe('free');
	});

	it('does not believe the status written in the event', async () => {
		const customer = await checkedOut('ada');
		const subscription = stripe.subscribe(customer, 'incomplete');
		await deliver('customer.subscription.updated', {
			...subscription,
			status: 'active',
		});
		expect(planOf('ada')).toBe('free');
	});

	it.each([
		['active', 'paid'],
		['trialing', 'paid'],
		// Stripe is retrying the card; the reader keeps what they paid for.
		['past_due', 'paid'],
		['unpaid', 'free'],
		['canceled', 'free'],
		// Payment still to be confirmed, a 3-D Secure check for one.
		['incomplete', 'free'],
		['incomplete_expired', 'free'],
		['paused', 'free'],
	] as const)('%s means %s', async (status, plan) => {
		const customer = await checkedOut('ada');
		await deliver(
			'customer.subscription.updated',
			stripe.subscribe(customer, status)
		);
		expect(planOf('ada')).toBe(plan);
	});

	it('keeps Paid on until a cancelled subscription actually ends', async () => {
		const customer = await checkedOut('ada');
		const subscription = stripe.subscribe(customer);
		await completed('ada', subscription);

		subscription.cancel_at_period_end = true;
		subscription.cancel_at = NOW + MONTH;
		await deliver('customer.subscription.updated', subscription);
		expect(planOf('ada')).toBe('paid');

		const { billing } = (await (await call('/billing', 'ada')).json()) as {
			billing: {
				subscription: {
					renews_at: string | null;
					ends_at: string | null;
				};
			};
		};
		expect(billing.subscription.renews_at).toBeNull();
		expect(billing.subscription.ends_at).toBe(
			new Date((NOW + MONTH) * 1000).toISOString()
		);

		subscription.status = 'canceled';
		await deliver('customer.subscription.deleted', subscription);
		expect(planOf('ada')).toBe('free');
	});

	it('follows an invoice to its subscription', async () => {
		const customer = await checkedOut('ada');
		const subscription = stripe.subscribe(customer, 'past_due');
		await deliver('invoice.payment_failed', {
			id: 'in_1',
			object: 'invoice',
			parent: { subscription_details: { subscription: subscription.id } },
		});
		expect(stripe.retrieved).toEqual([subscription.id]);
		expect(planOf('ada')).toBe('paid');
	});

	it('stays Paid while any one subscription pays', async () => {
		const customer = await checkedOut('ada');
		const old = stripe.subscribe(customer, 'canceled');
		const current = stripe.subscribe(customer, 'active');
		await deliver('customer.subscription.updated', current);
		await deliver('customer.subscription.deleted', old);
		expect(planOf('ada')).toBe('paid');
	});
});

describe('who a payment belongs to', () => {
	it('logs a customer it has never seen, and grants nothing', async () => {
		const stray = stripe.subscribe('cus_elsewhere');
		const response = await deliver('customer.subscription.created', stray);

		expect(response.status).toBe(200);
		expect(events()[0].error).toMatch(
			/no reader for customer cus_elsewhere/
		);
		expect(planOf('ada')).toBe('free');
		expect(planOf('ben')).toBe('free');
	});

	it('never moves a customer from one reader to another', async () => {
		const customer = await checkedOut('ada');
		// A subscription on ada's customer that claims, in its metadata, to be
		// ben's. The customer decides.
		await deliver(
			'customer.subscription.created',
			stripe.subscribe(customer, 'active', {
				metadata: { user_id: 'ben' },
			})
		);
		expect(planOf('ada')).toBe('paid');
		expect(planOf('ben')).toBe('free');
		expect(customerOf('ben')).toBeNull();
	});

	it('will not give a reader a second customer', async () => {
		await checkedOut('ada');
		const other = stripe.subscribe('cus_other', 'active', {
			metadata: { user_id: 'ada' },
		});
		await deliver('customer.subscription.created', other);
		expect(events()[0].error).toMatch(/tied to another customer/);
		expect(customerOf('ada')).not.toBe('cus_other');
	});

	it('ignores a checkout that did not start a subscription', async () => {
		const response = await deliver('checkout.session.completed', {
			id: 'cs_2',
			object: 'checkout.session',
			mode: 'payment',
			client_reference_id: 'ada',
			customer: 'cus_1',
			subscription: null,
		});
		expect(response.status).toBe(200);
		expect(planOf('ada')).toBe('free');
	});
});

describe('when Stripe cannot be reached mid-webhook', () => {
	it('answers 500 so Stripe retries, and the retry lands', async () => {
		const customer = await checkedOut('ada');
		const subscription = stripe.subscribe(customer);

		stripe.down = true;
		const failed = await deliver(
			'customer.subscription.created',
			subscription,
			{
				id: 'evt_retry',
			}
		);
		expect(failed.status).toBe(500);
		expect(events()[0]).toMatchObject({ processed_at: null });
		expect(events()[0].error).toMatch(/unreachable/);
		expect(planOf('ada')).toBe('free');

		stripe.down = false;
		const retried = await deliver(
			'customer.subscription.created',
			subscription,
			{
				id: 'evt_retry',
			}
		);
		expect(retried.status).toBe(200);
		expect(planOf('ada')).toBe('paid');
	});
});

describe('POST /billing/portal', () => {
	it('opens Stripe’s page for the reader’s own customer', async () => {
		const customer = await checkedOut('ada');
		const response = await call('/billing/portal', 'ada', {
			method: 'POST',
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			url: 'https://billing.stripe.test/p_1',
		});
		expect(stripe.portals[0]).toMatchObject({
			customer,
			return_url: 'https://scribe.socialeating.studio/?billing=returned',
		});
	});

	it('says there is nothing to manage before a first checkout', async () => {
		const response = await call('/billing/portal', 'ben', {
			method: 'POST',
		});
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			code: 'NO_BILLING_ACCOUNT',
		});
	});
});

describe('GET /plans, priced by Stripe', () => {
	type Offer = { id: string; price: { amount_cents: number } | null };

	it('shows the price on sale, on Paid only', async () => {
		const { plans } = (await (await call('/plans', 'ada')).json()) as {
			plans: Offer[];
		};
		expect(plans.map((p) => p.price?.amount_cents ?? null)).toEqual([
			null,
			2000,
		]);
	});

	it('still opens when Stripe does not answer', async () => {
		stripe.down = true;
		const response = await call('/plans', 'ada');
		expect(response.status).toBe(200);
		const { plans } = (await response.json()) as { plans: Offer[] };
		expect(plans.every((p) => p.price === null)).toBe(true);
	});
});

describe('the ledger', () => {
	it('is not touched by a plan changing', async () => {
		db.raw
			.prepare(
				`INSERT INTO usage_events (id, user_id, billing_month, kind, created_at)
				 VALUES ('u-1', 'ada', '2026-09', 'chat_turn', ?)`
			)
			.run(AT);
		const customer = await checkedOut('ada');
		const subscription = stripe.subscribe(customer);
		await completed('ada', subscription);
		subscription.status = 'canceled';
		await deliver('customer.subscription.deleted', subscription);

		expect(
			db.raw.prepare(`SELECT COUNT(*) AS n FROM usage_events`).get()
		).toEqual({ n: 1 });
	});
});
