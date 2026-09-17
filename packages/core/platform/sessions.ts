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
			`SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')`
		)
		.bind(token)
		.first<SessionRow>();
	return result ?? null;
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

/**
 * Remove expired sessions. Returns count of deleted rows.
 */
export async function cleanupExpiredSessions(db: D1Database): Promise<number> {
	const result = await db
		.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`)
		.run();
	return result.meta?.changes ?? 0;
}
