import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TURNS_PER_MONTH } from '@alexandria/core/platform';
import router from '../api/router.js';
import {
	migratedTestDatabase,
	type TestDatabase,
} from '../../../packages/core/test/d1.js';
import type { PlanOffer } from '../api/conversations/plans.js';

let db: TestDatabase;

beforeEach(() => {
	db = migratedTestDatabase();
	db.raw
		.prepare(
			`INSERT INTO users (id, email, first_seen, last_seen) VALUES (?, ?, ?, ?)`
		)
		.run(
			'u1',
			'reader@example.test',
			'2026-01-01T00:00:00Z',
			'2026-01-01T00:00:00Z'
		);
	db.raw
		.prepare(
			`INSERT INTO sessions (token, user_id, email, role, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(
			't1',
			'u1',
			'reader@example.test',
			'member',
			'2026-01-01T00:00:00Z',
			'2099-01-01T00:00:00Z'
		);
});

afterEach(() => db.close());

const call = (path: string, init: RequestInit = {}, cookie = '__session=t1') =>
	router.fetch(
		new Request(`http://alexandria.test${path}`, {
			...init,
			headers: { cookie },
		}),
		{
			DB: db.d1,
			ADMIN_EMAIL: 'admin@example.test',
			LOCAL_DEV: 'false',
			OPENAI_API_KEY: 'k',
			GOOGLE_GENERATIVE_AI_API_KEY: 'k',
		}
	);

describe('GET /plans', () => {
	it('promises only what the limit and the roster will give', async () => {
		const { plans } = (await (await call('/plans')).json()) as {
			plans: PlanOffer[];
		};
		const [free, paid] = plans;

		expect(free.id).toBe('free');
		expect(free.turns_per_month).toBe(TURNS_PER_MONTH.free);
		expect(free.models.map((m) => m.id)).toEqual(['gpt-5.6-luna']);

		expect(paid.id).toBe('paid');
		expect(paid.turns_per_month).toBe(TURNS_PER_MONTH.paid);
		// No Anthropic key, so Haiku is not promised.
		expect(paid.models.map((m) => m.id)).toEqual([
			'gpt-5.6-luna',
			'gemini-3.8-flash',
		]);
	});

	it('names no price until there is one', async () => {
		const { plans } = (await (await call('/plans')).json()) as {
			plans: PlanOffer[];
		};
		expect(plans.every((plan) => plan.price === null)).toBe(true);
	});

	it('needs a session', async () => {
		expect((await call('/plans', {}, '')).status).toBe(401);
	});
});

describe('POST /billing/checkout', () => {
	it('says checkout is not open, in a shape the client acts on', async () => {
		const response = await call('/billing/checkout', { method: 'POST' });
		expect(response.status).toBe(501);
		expect(((await response.json()) as { code: string }).code).toBe(
			'CHECKOUT_NOT_OPEN'
		);
	});
});
