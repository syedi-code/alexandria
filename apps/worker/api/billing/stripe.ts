import Stripe from 'stripe';
import type { Env } from '@alexandria/core/platform';
import { stripeClient } from './client.js';

/**
 * What the billing routes know about Stripe beyond its client: the webhook
 * verifier, the price on sale, and where to send a reader back to. The client
 * itself is in `client.ts`, alone, so a test replaces that and nothing else —
 * signature checks here stay real in every test, because a webhook handler
 * tested against a faked verifier has not been tested.
 */

export const DEFAULT_PRICE_LOOKUP_KEY = 'scribe_paid_monthly';
export const DEFAULT_SCRIBE_ORIGIN = 'https://scribe.socialeating.studio';

export const isBillingOpen = (env: Env) => Boolean(env.STRIPE_SECRET_KEY);

const verifier = new Stripe('sk_verify_only', {
	httpClient: Stripe.createFetchHttpClient(),
});
const crypto = Stripe.createSubtleCryptoProvider();

/**
 * The event, if its signature is Stripe's for this endpoint and it is recent;
 * throws otherwise. The async form, because Workers has no synchronous crypto.
 */
export function verifyWebhook(
	env: Env,
	payload: string,
	signature: string
): Promise<Stripe.Event> {
	if (!env.STRIPE_WEBHOOK_SECRET) {
		throw new Error('STRIPE_WEBHOOK_SECRET is not set');
	}
	return verifier.webhooks.constructEventAsync(
		payload,
		signature,
		env.STRIPE_WEBHOOK_SECRET,
		undefined,
		crypto
	);
}

export interface Price {
	id: string;
	amount_cents: number;
	currency: string;
	interval: 'month';
}

let priceCache: { key: string; price: Price; at: number } | null = null;
const PRICE_TTL_MS = 10 * 60 * 1000;

/**
 * The Price on sale, found by lookup key rather than an id pasted into
 * config, so the setup script can make it and the code never names it. Kept
 * for ten minutes: the plans page asks on every open, and a price is not a
 * thing that changes under a reader mid-session.
 */
export async function priceOnSale(env: Env): Promise<Price | null> {
	const key = env.STRIPE_PRICE_LOOKUP_KEY ?? DEFAULT_PRICE_LOOKUP_KEY;
	if (priceCache?.key === key && Date.now() - priceCache.at < PRICE_TTL_MS) {
		return priceCache.price;
	}
	const { data } = await stripeClient(env).prices.list({
		lookup_keys: [key],
		active: true,
		limit: 1,
	});
	const found = data[0];
	if (
		!found ||
		found.unit_amount === null ||
		found.recurring?.interval !== 'month'
	) {
		return null;
	}
	const price: Price = {
		id: found.id,
		amount_cents: found.unit_amount,
		currency: found.currency,
		interval: 'month',
	};
	priceCache = { key, price, at: Date.now() };
	return price;
}

/** Tests only: forget the price, so one test's Stripe is not the next one's. */
export const forgetPrice = () => {
	priceCache = null;
};

export const scribeOrigin = (env: Env) =>
	(env.SCRIBE_ORIGIN ?? DEFAULT_SCRIBE_ORIGIN).replace(/\/$/, '');
