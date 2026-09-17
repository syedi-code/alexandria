import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { migratedTestDatabase, type TestDatabase } from './d1.js';
import {
	createSession,
	DEFAULT_SESSION_DURATION_HOURS,
	extendSession,
	getSessionByToken,
	MAX_SESSION_DURATION_HOURS,
	sessionDurationHours,
} from '../platform/sessions.js';

let db: TestDatabase;

beforeEach(() => {
	db = migratedTestDatabase();
	db.raw
		.prepare(
			`INSERT INTO users (id, email, first_seen, last_seen) VALUES (?, ?, ?, ?)`
		)
		.run('user-1', 'admin@example.test', '2026-01-01', '2026-01-01');
});

afterEach(() => db.close());

const signIn = (durationHours?: number) =>
	createSession(db.d1, {
		userId: 'user-1',
		email: 'admin@example.test',
		role: 'admin',
		durationHours,
	});

/**
 * SESSION_DURATION_HOURS arrives as an unvalidated env string. It used to be
 * parseInt'd straight into Date arithmetic and into a SQL literal, so a typo
 * in the binding threw on sign-in and nulled the expiry on extend.
 */
describe('sessionDurationHours', () => {
	it('takes a sensible value as given', () => {
		expect(sessionDurationHours('24')).toBe(24);
		expect(sessionDurationHours(6)).toBe(6);
	});

	it('falls back to the default for anything unparseable', () => {
		for (const value of [undefined, '', 'abc', 'NaN', '0', '-5', ' ']) {
			expect(sessionDurationHours(value)).toBe(
				DEFAULT_SESSION_DURATION_HOURS
			);
		}
	});

	it('caps an absurd value rather than trusting it', () => {
		expect(sessionDurationHours('999999')).toBe(MAX_SESSION_DURATION_HOURS);
	});
});

describe('createSession', () => {
	it('survives a misconfigured duration instead of throwing', async () => {
		const session = await createSession(db.d1, {
			userId: 'user-1',
			email: 'admin@example.test',
			role: 'admin',
			durationHours: Number.NaN,
		});
		expect(Number.isNaN(Date.parse(session.expires_at))).toBe(false);
	});

	it('mints a token that is not guessable from the row', async () => {
		const a = await signIn();
		const b = await signIn();
		expect(a.token).not.toBe(b.token);
		expect(a.token).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('extendSession', () => {
	it('keeps the session findable afterwards', async () => {
		const session = await signIn(12);
		await extendSession(db.d1, session.token, 12);
		await expect(
			getSessionByToken(db.d1, session.token)
		).resolves.not.toBeNull();
	});

	it('does not null the expiry when handed a bad duration', async () => {
		const session = await signIn(12);
		await extendSession(db.d1, session.token, Number.NaN);

		const row = db.raw
			.prepare(`SELECT expires_at FROM sessions WHERE token = ?`)
			.get(session.token) as { expires_at: string | null };
		expect(row.expires_at).not.toBeNull();
		await expect(
			getSessionByToken(db.d1, session.token)
		).resolves.not.toBeNull();
	});
});
