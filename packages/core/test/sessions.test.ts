import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { migratedTestDatabase, type TestDatabase } from './d1.js';
import {
	createSession,
	DEFAULT_SESSION_DURATION_HOURS,
	extendSession,
	getSessionByToken,
	MAX_SESSION_DURATION_HOURS,
	sessionDurationHours,
	sessionNeedsExtending,
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

/**
 * The sliding window used to be written on every request, which is what ran the
 * account into D1's daily row-write limit and 500'd every route behind the
 * middleware.
 */
describe('sessionNeedsExtending', () => {
	const HOUR = 60 * 60 * 1000;
	const now = Date.parse('2026-09-17T12:00:00.000Z');
	const isoIn = (hours: number) => new Date(now + hours * HOUR).toISOString();
	/** What SQLite's `datetime()` writes: UTC, but naming no zone. */
	const sqliteIn = (hours: number) =>
		isoIn(hours).slice(0, 19).replace('T', ' ');

	it('does not write for a session still in its first half', () => {
		expect(sessionNeedsExtending(isoIn(12), 12, now)).toBe(false);
		expect(sessionNeedsExtending(isoIn(7), 12, now)).toBe(false);
	});

	it('writes once the session is past halfway', () => {
		expect(sessionNeedsExtending(isoIn(6), 12, now)).toBe(true);
		expect(sessionNeedsExtending(isoIn(1), 12, now)).toBe(true);
	});

	it('reads a zoneless SQLite timestamp as UTC, not local time', () => {
		expect(sessionNeedsExtending(sqliteIn(11), 12, now)).toBe(false);
		expect(sessionNeedsExtending(sqliteIn(2), 12, now)).toBe(true);
	});

	it('extends rather than locking out when the expiry is unreadable', () => {
		expect(sessionNeedsExtending('not a date', 12, now)).toBe(true);
	});

	it('measures against the fallback when the duration is unusable', () => {
		const half = DEFAULT_SESSION_DURATION_HOURS / 2;
		expect(sessionNeedsExtending(isoIn(half + 1), Number.NaN, now)).toBe(
			false
		);
		expect(sessionNeedsExtending(isoIn(half - 1), Number.NaN, now)).toBe(
			true
		);
	});

	it('agrees with a freshly created session', async () => {
		const session = await signIn(12);
		expect(sessionNeedsExtending(session.expires_at, 12)).toBe(false);
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
