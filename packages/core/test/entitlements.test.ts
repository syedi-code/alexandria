import { describe, it, expect, beforeEach } from 'vitest';
import type { TestDatabase } from './d1.js';
import { catalogueTestDatabase, ids } from './fixture.js';
import { createConversation, saveMessage } from '../conversations/index.js';
import {
	entitlementFor,
	hasTurnsLeft,
	monthResetsAt,
	TURNS_PER_MONTH,
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
			limit: TURNS_PER_MONTH.free,
		});
		expect(hasTurnsLeft(e)).toBe(true);
	});

	it('counts turns against the limit and stops at it', async () => {
		await takeTurns(ids.userOther, TURNS_PER_MONTH.free - 1);
		expect(
			hasTurnsLeft(await entitlementFor(db.d1, ids.userOther, 'member'))
		).toBe(true);

		await takeTurns(ids.userOther, 1);
		const spent = await entitlementFor(db.d1, ids.userOther, 'member');
		expect(spent.used).toBe(TURNS_PER_MONTH.free);
		expect(hasTurnsLeft(spent)).toBe(false);
	});

	it('gives a paid reader the paid limit', async () => {
		await db.d1
			.prepare(`UPDATE users SET plan = 'paid' WHERE id = ?`)
			.bind(ids.userOther)
			.run();
		const e = await entitlementFor(db.d1, ids.userOther, 'member');
		expect(e).toMatchObject({ plan: 'paid', limit: TURNS_PER_MONTH.paid });
	});

	it('never limits the admin, however many turns they have taken', async () => {
		await takeTurns(ids.userAdmin, TURNS_PER_MONTH.free + 5);
		const e = await entitlementFor(db.d1, ids.userAdmin, 'admin');
		expect(e.limit).toBeNull();
		expect(e.used).toBe(TURNS_PER_MONTH.free + 5);
		expect(hasTurnsLeft(e)).toBe(true);
	});

	it("does not count another reader's turns", async () => {
		await takeTurns(ids.userAdmin, 5);
		expect(
			(await entitlementFor(db.d1, ids.userOther, 'member')).used
		).toBe(0);
	});

	it('resets at midnight UTC on the first of next month', () => {
		expect(monthResetsAt('2026-09-20T23:59:59.000Z')).toBe(
			'2026-10-01T00:00:00.000Z'
		);
		expect(monthResetsAt('2026-12-31T00:00:00.000Z')).toBe(
			'2027-01-01T00:00:00.000Z'
		);
	});

	it('counts only the month asked about', async () => {
		await takeTurns(ids.userOther, 3);
		await db.d1
			.prepare(`UPDATE usage_events SET billing_month = '2026-08'`)
			.run();
		expect(
			(await entitlementFor(db.d1, ids.userOther, 'member')).used
		).toBe(0);
	});
});
