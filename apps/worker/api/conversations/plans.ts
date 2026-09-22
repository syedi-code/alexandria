import { Hono } from 'hono';
import type { AuthContext, Env, UserPlan } from '@alexandria/core/platform';
import { PAGE_SCANS, TURNS_PER_MONTH } from '@alexandria/core/platform';
import { requireAuth } from '../auth.js';
import { isBillingOpen, priceOnSale, type Price } from '../billing/stripe.js';
import { availableModels } from './models.js';

/**
 * What each plan gives, for a client to lay side by side.
 *
 * Read from the same two places the limit is enforced from — `TURNS_PER_MONTH`
 * and the model table — so the page that sells a plan cannot promise a number
 * or a model the server would then refuse. A free reader's roster lists only
 * free models, which is why this is its own route: the plans page has to name
 * what a reader does not have yet.
 */
export interface PlanOffer {
	id: UserPlan;
	turns_per_month: number;
	models: { id: string; label: string; provider: string }[];
	/** Whether the scan of a cited page can be opened, one page at a time. */
	page_scans: boolean;
	/** Null until Stripe has a price on sale; never a figure typed here. */
	price: { amount_cents: number; currency: string; interval: 'month' } | null;
}

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

app.use('/plans', requireAuth());

const offer = (env: Env, id: UserPlan, price: Price | null): PlanOffer => ({
	id,
	turns_per_month: TURNS_PER_MONTH[id],
	models: availableModels(env, id).map(({ id, label, provider }) => ({
		id,
		label,
		provider,
	})),
	page_scans: PAGE_SCANS[id],
	price:
		id === 'paid' && price
			? {
					amount_cents: price.amount_cents,
					currency: price.currency,
					interval: price.interval,
				}
			: null,
});

/**
 * The price on sale, or null. A plans page that cannot reach Stripe still
 * opens and says the price is to come, rather than failing whole.
 */
async function currentPrice(env: Env): Promise<Price | null> {
	if (!isBillingOpen(env)) return null;
	try {
		return await priceOnSale(env);
	} catch (error) {
		console.error('[billing] the price could not be read', error);
		return null;
	}
}

// GET /plans
app.get('/plans', async (c) => {
	const price = await currentPrice(c.env);
	return c.json({
		plans: [offer(c.env, 'free', price), offer(c.env, 'paid', price)],
	});
});

export default app;
