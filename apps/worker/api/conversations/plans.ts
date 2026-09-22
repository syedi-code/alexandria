import { Hono } from 'hono';
import type { AuthContext, Env, UserPlan } from '@alexandria/core/platform';
import { PAGE_SCANS, TURNS_PER_MONTH } from '@alexandria/core/platform';
import { requireAuth } from '../auth.js';
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
	/** Null until there is a price to show; Stripe will own it. */
	price: { amount_cents: number; currency: string; interval: 'month' } | null;
}

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

app.use('/plans', requireAuth());
app.use('/billing/*', requireAuth());

const offer = (env: Env, id: UserPlan): PlanOffer => ({
	id,
	turns_per_month: TURNS_PER_MONTH[id],
	models: availableModels(env, id).map(({ id, label, provider }) => ({
		id,
		label,
		provider,
	})),
	page_scans: PAGE_SCANS[id],
	price: null,
});

// GET /plans
app.get('/plans', (c) =>
	c.json({ plans: [offer(c.env, 'free'), offer(c.env, 'paid')] })
);

// POST /billing/checkout — where a Stripe Checkout session will be minted and
// its URL returned. Until then it says so in a shape the client already acts
// on, so the client's half of checkout is finished and waits only on this.
app.post('/billing/checkout', (c) =>
	c.json(
		{
			error: 'Paid plans are not open yet.',
			code: 'CHECKOUT_NOT_OPEN',
		},
		501
	)
);

export default app;
