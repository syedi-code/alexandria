import { describe, it, expect, beforeEach } from 'vitest';
import type { TestDatabase } from './d1.js';
import { catalogueTestDatabase, ids } from './fixture.js';
import { createConversation, saveMessage } from '../conversations/index.js';
import {
	entitlementFor,
	hasTurnsLeft,
	weekResetsAt,
	billingWeek,
	allowanceFor,
	TURNS_PER_WEEK,
} from '../platform/index.js';

let db: TestDatabase;

beforeEach(() => {
	db = catalogueTestDatabase();
});

async function takeTurns(userId: string, count: number): Promise<void> {
	const conversation = await createConversation(db.d1, userId, {
		model_id: 'gpt-5.6-luna',
	});
	for (let i = 0; i < count; i++) {
		await saveMessage(db.d1, {
			conversationId: conversation.id,
			message: {
				id: crypto.randomUUID(),
				role: 'assistant',
				parts: [{ type: 'text', text: 'ok' }],
			},
			usage: { inputTokens: 10, outputTokens: 1 },
		});
	}
}

describe('entitlements', () => {
	it('starts every reader on the free plan with a full allowance', async () => {
		const e = await entitlementFor(db.d1, ids.userOther, 'member');
		expect(e).toMatchObject({
			plan: 'free',
			used: 0,
			limit: TURNS_PER_WEEK.free,
		});
		expect(hasTurnsLeft(e)).toBe(true);
	});

	it('counts turns against the limit and stops at it', async () => {
		await takeTurns(ids.userOther, TURNS_PER_WEEK.free - 1);
		expect(
			hasTurnsLeft(await entitlementFor(db.d1, ids.userOther, 'member'))
		).toBe(true);

		await takeTurns(ids.userOther, 1);
		const spent = await entitlementFor(db.d1, ids.userOther, 'member');
		expect(spent.used).toBe(TURNS_PER_WEEK.free);
		expect(hasTurnsLeft(spent)).toBe(false);
	});

	it('gives a paid reader the paid limit', async () => {
		await db.d1
			.prepare(`UPDATE users SET plan = 'paid' WHERE id = ?`)
			.bind(ids.userOther)
			.run();
		const e = await entitlementFor(db.d1, ids.userOther, 'member');
		expect(e).toMatchObject({ plan: 'paid', limit: TURNS_PER_WEEK.paid });
	});

	it('never limits the admin, however many turns they have taken', async () => {
		await takeTurns(ids.userAdmin, TURNS_PER_WEEK.free + 5);
		const e = await entitlementFor(db.d1, ids.userAdmin, 'admin');
		expect(e.limit).toBeNull();
		expect(e.used).toBe(TURNS_PER_WEEK.free + 5);
		expect(hasTurnsLeft(e)).toBe(true);
	});

	it("does not count another reader's turns", async () => {
		await takeTurns(ids.userAdmin, 5);
		expect(
			(await entitlementFor(db.d1, ids.userOther, 'member')).used
		).toBe(0);
	});

	it('resets at midnight UTC on Monday', () => {
		// A Sunday resets the next day, not in six.
		expect(weekResetsAt('2026-09-20T23:59:59.000Z')).toBe(
			'2026-09-21T00:00:00.000Z'
		);
		// A Monday resets a whole week on, never the same midnight.
		expect(weekResetsAt('2026-09-21T00:00:00.000Z')).toBe(
			'2026-09-28T00:00:00.000Z'
		);
	});

	// The year of an ISO week is the year of its Thursday, which is the whole
	// reason not to count sevens from the first of January: without it the
	// last days of December are a two-day week.
	it('numbers a week by its Thursday, across the new year', () => {
		expect(billingWeek('2026-12-31T12:00:00.000Z')).toBe('2026-W53');
		expect(billingWeek('2027-01-01T12:00:00.000Z')).toBe('2026-W53');
		expect(billingWeek('2027-01-04T12:00:00.000Z')).toBe('2027-W01');
	});

	it('counts only the week asked about', async () => {
		await takeTurns(ids.userOther, 3);
		await db.d1
			.prepare(`UPDATE usage_events SET billing_week = '2026-W01'`)
			.run();
		expect(
			(await entitlementFor(db.d1, ids.userOther, 'member')).used
		).toBe(0);
	});

	// The number has to be movable without a deploy, and a broken row must
	// never be the reason nobody can ask a question.
	it('takes the allowance from settings, and derives free from paid', async () => {
		await db.d1
			.prepare(
				`INSERT INTO settings (key, value, updated_at) VALUES ('paid_turns_per_week', '50', '2026-09-23')`
			)
			.run();
		expect(await allowanceFor(db.d1)).toEqual({ paid: 50, free: 6 });

		await db.d1
			.prepare(`UPDATE settings SET value = 'nonsense'`)
			.run();
		expect(await allowanceFor(db.d1)).toEqual({
			paid: TURNS_PER_WEEK.paid,
			free: TURNS_PER_WEEK.free,
		});
	});
});
