/// <reference types="@cloudflare/workers-types" />
import type { SessionRow } from './schema.js';

export const DEFAULT_SESSION_DURATION_HOURS = 12;
export const MAX_SESSION_DURATION_HOURS = 24 * 30;

/**
 * A duration a session can actually be given, from a value that arrives as an
 * unvalidated env string. An unparseable one used to reach Date arithmetic as
 * NaN, where `toISOString` throws on sign-in and SQLite's `datetime` returns
 * NULL on extend — an expiry that no longer compares true, logging the user
 * out on their next request.
 */
export function sessionDurationHours(
	value: string | number | undefined
): number {
	const hours =
		typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
	if (!Number.isFinite(hours) || hours < 1) {
		return DEFAULT_SESSION_DURATION_HOURS;
	}
	return Math.min(Math.floor(hours), MAX_SESSION_DURATION_HOURS);
}

/**
 * Create a new session with a cryptographically random token.
 */
export async function createSession(
	db: D1Database,
	params: {
		userId: string;
		email: string;
		role: 'admin' | 'member';
		durationHours?: number;
	}
): Promise<SessionRow> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const token = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

	const hours = sessionDurationHours(params.durationHours);
	const expiresAt = new Date(
		Date.now() + hours * 60 * 60 * 1000
	).toISOString();
	const createdAt = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO sessions (token, user_id, email, role, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.bind(
			token,
			params.userId,
			params.email,
			params.role,
			createdAt,
			expiresAt
		)
		.run();

	return {
		token,
		user_id: params.userId,
		email: params.email,
		role: params.role,
		created_at: createdAt,
		expires_at: expiresAt,
	};
}

/**
 * Look up a session by token. Returns null if not found or expired.
 */
export async function getSessionByToken(
	db: D1Database,
	token: string
): Promise<SessionRow | null> {
	const result = await db
		.prepare(
			`SELECT s.*, u.is_guest AS is_guest
			   FROM sessions s LEFT JOIN users u ON u.id = s.user_id
			  WHERE s.token = ? AND s.expires_at > datetime('now')`
		)
		.bind(token)
		.first<SessionRow>();
	return result ?? null;
}

/**
 * `expires_at` is written in two shapes: an ISO string by `createSession`, and
 * SQLite's `YYYY-MM-DD HH:MM:SS` by `extendSession`, which names no zone but is
 * always UTC. `Date.parse` reads the second as local time, so the zone is made
 * explicit rather than trusted.
 */
function expiryMs(expiresAt: string): number {
	const normalised = expiresAt.includes('T')
		? expiresAt
		: `${expiresAt.replace(' ', 'T')}Z`;
	return Date.parse(normalised);
}

/**
 * Whether the sliding window is worth a write.
 *
 * Extending on every request cost one D1 row write per request, which is what
 * exhausted the account's daily write budget and took every route down with it
 * — reading the notes list should not spend write quota. A session is bumped
 * only once it is past halfway through its duration, which keeps the window
 * sliding while turning a write per request into a write per half-duration.
 *
 * An unreadable expiry extends, so a parsing fault logs nobody out.
 */
export function sessionNeedsExtending(
	expiresAt: string,
	durationHours?: number,
	now: number = Date.now()
): boolean {
	const expiry = expiryMs(expiresAt);
	if (!Number.isFinite(expiry)) return true;
	const halfWindowMs =
		(sessionDurationHours(durationHours) * 60 * 60 * 1000) / 2;
	return expiry - now <= halfWindowMs;
}

/**
 * Extend a session's expiry (sliding window).
 */
export async function extendSession(
	db: D1Database,
	token: string,
	durationHours?: number
): Promise<void> {
	const hours = sessionDurationHours(durationHours);
	await db
		.prepare(
			`UPDATE sessions SET expires_at = datetime('now', ?) WHERE token = ?`
		)
		.bind(`+${hours} hours`, token)
		.run();
}

/**
 * Delete a specific session (explicit logout).
 */
export async function deleteSession(
	db: D1Database,
	token: string
): Promise<void> {
	await db.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
}

/**
 * Delete all sessions for a user (force-logout).
 */
export async function deleteUserSessions(
	db: D1Database,
	userId: string
): Promise<void> {
	await db
		.prepare(`DELETE FROM sessions WHERE user_id = ?`)
		.bind(userId)
		.run();
}

/** How long an expired session is kept: long enough to answer who signed in lately. */
export const EXPIRED_SESSION_RETENTION_DAYS = 30;

/**
 * Remove sessions that expired more than `retentionDays` ago. Returns the count.
 *
 * Compared through julianday(), not as text: rows written before createSession
 * used toISOString() hold `2026-03-18 17:32:15`, later ones
 * `2026-09-19T04:44:23.806Z`, and as strings a `T` sorts after the space, so a
 * same-day ISO expiry never compared as past.
 */
export async function cleanupExpiredSessions(
	db: D1Database,
	retentionDays = 0
): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM sessions
			  WHERE julianday(expires_at) <= julianday('now', ?)`
		)
		.bind(`-${retentionDays} days`)
		.run();
	return result.meta?.changes ?? 0;
}
