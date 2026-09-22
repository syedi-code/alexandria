import { Hono } from 'hono';
import type { AuthContext, Env } from '@alexandria/core/platform';
import {
	billingFor,
	claimCustomer,
	customerIdForUser,
	entitlementFor,
} from '@alexandria/core/platform';
import { requireAuth } from '../auth.js';
import { stripeClient } from './client.js';
import { isBillingOpen, priceOnSale, scribeOrigin } from './stripe.js';
import { syncCustomer } from './sync.js';

/**
 * A reader's side of billing: start paying, manage what they pay, and see
 * what they are on. Card details never pass through here — checkout and the
 * portal are Stripe's pages, and these routes only mint the links to them.
 */
const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

app.use('/billing', requireAuth());
app.use('/billing/checkout', requireAuth());
app.use('/billing/portal', requireAuth());

const closed = {
	error: 'Paid plans are not open yet.',
	code: 'CHECKOUT_NOT_OPEN',
} as const;

const alreadyPaid = {
	error: 'You are already on Paid.',
	code: 'ALREADY_PAID',
} as const;

// GET /billing — the plan, and the subscription behind it, for the account sheet
app.get('/billing', async (c) => {
	const billing = await billingFor(c.env.DB, c.get('authContext').user.id);
	return c.json({ billing });
});

// POST /billing/checkout — a Stripe Checkout page for Paid, or why not
app.post('/billing/checkout', async (c) => {
	if (!isBillingOpen(c.env)) return c.json(closed, 501);

	const { user, role } = c.get('authContext');
	if (role === 'admin') {
		return c.json(
			{
				error: 'The admin has no limit to pay for.',
				code: 'ALREADY_UNLIMITED',
			},
			409
		);
	}
	const entitlement = await entitlementFor(c.env.DB, user.id, role);
	if (entitlement.plan === 'paid') return c.json(alreadyPaid, 409);

	const price = await priceOnSale(c.env);
	if (!price) {
		console.error('[billing] no active monthly price on sale');
		return c.json(closed, 501);
	}

	const stripe = stripeClient(c.env);
	let customer = await customerIdForUser(c.env.DB, user.id);
	if (!customer) {
		// Keyed on the reader, so two checkouts pressed at once, or a retry,
		// get the same customer from Stripe rather than one each.
		const created = await stripe.customers.create(
			{ email: user.email, metadata: { user_id: user.id } },
			{ idempotencyKey: `customer-for-${user.id}` }
		);
		customer = await claimCustomer(c.env.DB, user.id, created.id);
		if (!customer) throw new Error('A new customer could not be tied');
	}

	// The webhook may be behind a payment that has already gone through; a
	// second checkout then would bill the same reader twice.
	const synced = await syncCustomer(c.env, stripe, customer, user.id);
	if (synced.some((s) => 'plan' in s && s.plan === 'paid')) {
		return c.json(alreadyPaid, 409);
	}

	const origin = scribeOrigin(c.env);
	const automaticTax = c.env.STRIPE_AUTOMATIC_TAX === 'true';
	const session = await stripe.checkout.sessions.create({
		mode: 'subscription',
		customer,
		client_reference_id: user.id,
		line_items: [{ price: price.id, quantity: 1 }],
		subscription_data: { metadata: { user_id: user.id } },
		success_url: `${origin}/?checkout=done`,
		cancel_url: `${origin}/?checkout=cancelled`,
		automatic_tax: { enabled: automaticTax },
		...(automaticTax ? { customer_update: { address: 'auto' } } : {}),
		allow_promotion_codes: false,
	});
	if (!session.url)
		throw new Error('Stripe returned a session without a url');
	return c.json({ url: session.url });
});

// POST /billing/portal — Stripe's page for cancelling, the card and invoices
app.post('/billing/portal', async (c) => {
	if (!isBillingOpen(c.env)) return c.json(closed, 501);

	const customer = await customerIdForUser(
		c.env.DB,
		c.get('authContext').user.id
	);
	if (!customer) {
		return c.json(
			{
				error: 'There is no billing to manage yet.',
				code: 'NO_BILLING_ACCOUNT',
			},
			404
		);
	}
	const session = await stripeClient(c.env).billingPortal.sessions.create({
		customer,
		return_url: `${scribeOrigin(c.env)}/?billing=returned`,
		...(c.env.STRIPE_PORTAL_CONFIGURATION
			? { configuration: c.env.STRIPE_PORTAL_CONFIGURATION }
			: {}),
	});
	return c.json({ url: session.url });
});

export default app;
