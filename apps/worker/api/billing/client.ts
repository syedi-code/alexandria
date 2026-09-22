import Stripe from 'stripe';
import type { Env } from '@alexandria/core/platform';

/** The one door to Stripe's API. Tests replace this module, and only this. */
export function stripeClient(env: Env): Stripe {
	if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
	return new Stripe(env.STRIPE_SECRET_KEY, {
		httpClient: Stripe.createFetchHttpClient(),
		// Stripe retries with the same idempotency key, so a retried create
		// never makes a second customer or session.
		maxNetworkRetries: 2,
		appInfo: { name: 'alexandria' },
	});
}
