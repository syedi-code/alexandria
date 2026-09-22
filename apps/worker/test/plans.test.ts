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
	db.raw
		.prepare(
			`INSERT INTO users (id, email, first_seen, last_seen) VALUES (?, ?, ?, ?)`
		)
		.run(
			'u2',
			'admin@example.test',
			'2026-01-01T00:00:00Z',
			'2026-01-01T00:00:00Z'
		);
	db.raw
		.prepare(
			`INSERT INTO sessions (token, user_id, email, role, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(
			't2',
			'u2',
			'admin@example.test',
			'admin',
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
			ANTHROPIC_API_KEY: 'k',
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
		// Sol is the admin's, and no plan is sold with it.
		expect(paid.models.map((m) => m.id)).toEqual([
			'gpt-5.6-luna',
			'claude-sonnet-5',
			'claude-haiku-4-5-20251001',
		]);
	});

	it('opens the scan of a cited page on Paid alone', async () => {
		const { plans } = (await (await call('/plans')).json()) as {
			plans: PlanOffer[];
		};
		expect(plans.map((plan) => plan.page_scans)).toEqual([false, true]);
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

describe('GET /models', () => {
	const roster = async (cookie: string) =>
		(await (await call('/models', {}, cookie)).json()) as {
			models: { id: string }[];
			locked: { id: string }[];
		};

	it("names what a free reader's plan leaves out as locked, not as missing", async () => {
		const { models, locked } = await roster('__session=t1');
		expect(models.map((m) => m.id)).toEqual(['gpt-5.6-luna']);
		expect(locked.map((m) => m.id)).toEqual([
			'claude-sonnet-5',
			'claude-haiku-4-5-20251001',
		]);
	});

	it('starts a paid reader on Sonnet and a free reader on Luna', async () => {
		db.raw.prepare(`UPDATE users SET plan = 'paid' WHERE id = 'u1'`).run();
		const paid = (await (await call('/models')).json()) as {
			default_model_id: string;
		};
		expect(paid.default_model_id).toBe('claude-sonnet-5');

		const created = (await (
			await call('/conversations', { method: 'POST', body: '{}' })
		).json()) as { conversation: { model_id: string } };
		expect(created.conversation.model_id).toBe('claude-sonnet-5');

		db.raw.prepare(`UPDATE users SET plan = 'free' WHERE id = 'u1'`).run();
		const free = (await (await call('/models')).json()) as {
			default_model_id: string;
		};
		expect(free.default_model_id).toBe('gpt-5.6-luna');
	});

	it('gives the admin Sol, and nobody else even hears of it', async () => {
		const admin = await roster('__session=t2');
		expect(admin.models.map((m) => m.id)).toContain('gpt-5.6-sol');
		expect(admin.locked).toEqual([]);

		const reader = await roster('__session=t1');
		expect(
			[...reader.models, ...reader.locked].map((m) => m.id)
		).not.toContain('gpt-5.6-sol');
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
