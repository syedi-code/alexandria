/// <reference types="@cloudflare/workers-types" />
import {
	FREE_SHARE_OF_PAID,
	PAID_TURNS_PER_WEEK_KEY,
	TURNS_PER_WEEK,
} from './limits.js';
import { GUEST_TURNS } from './guests.js';
import type { SqlStatement } from './sql.js';
import type { UserPlan } from './schema.js';
import type { UserRole } from './types.js';

/** What a turn cost, as the provider reported it. */
export interface TokenUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

export interface UsageEvent extends TokenUsage {
	kind: 'chat_turn';
	modelId?: string;
	conversationId: string;
	messageId: string;
}

/** 'YYYY-MM' in UTC, matching the stored `billing_month`. */
export const billingMonth = (at: string | Date = new Date()): string =>
	(typeof at === 'string' ? at : at.toISOString()).slice(0, 7);

/**
 * 'YYYY-Www' in UTC, matching the stored `billing_week`: the ISO week, whose
 * year is the year of its Thursday. So the last days of December belong to
 * week 1 of the next year, and a reader does not get a two-day week for
 * Christmas — which is the only reason to use the ISO rule rather than
 * counting sevens from the first of January.
 */
export function billingWeek(at: string | Date = new Date()): string {
	// Monday is day 0 for this purpose, and the week's Thursday is three on.
	const thursdayOf = (date: Date) =>
		new Date(
			Date.UTC(
				date.getUTCFullYear(),
				date.getUTCMonth(),
				date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + 3
			)
		);

	const thursday = thursdayOf(
		new Date(typeof at === 'string' ? at : at.toISOString())
	);
	// The 4th of January is in week 1 by definition, whatever day it falls on,
	// so its Thursday is week 1's Thursday and every week is counted from there.
	const first = thursdayOf(
		new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4))
	);
	const week =
		1 + Math.round((thursday.getTime() - first.getTime()) / 604_800_000);
	return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The ledger row for one turn, as a statement so it can join the transaction
 * that saves the message. `user_id` is selected from the conversation rather
 * than passed in: the ledger and the conversation cannot then disagree about
 * who to bill, and a turn on a conversation that has gone away writes nothing.
 */
export function usageEventStatement(
	event: UsageEvent,
	now: string
): SqlStatement {
	return {
		sql: `INSERT INTO usage_events (
		          id, user_id, billing_month, billing_week, kind, model_id,
		          conversation_id, message_id, input_tokens, cache_read_tokens,
		          cache_write_tokens, output_tokens, created_at)
		      SELECT ?, c.user_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		        FROM conversations c
		       WHERE c.id = ?
		      ON CONFLICT (id) DO UPDATE SET
		          model_id = excluded.model_id,
		          input_tokens = excluded.input_tokens,
		          cache_read_tokens = excluded.cache_read_tokens,
		          cache_write_tokens = excluded.cache_write_tokens,
		          output_tokens = excluded.output_tokens`,
		params: [
			event.messageId,
			billingMonth(now),
			billingWeek(now),
			event.kind,
			event.modelId ?? null,
			event.conversationId,
			event.messageId,
			event.inputTokens ?? 0,
			event.cacheReadTokens ?? 0,
			event.cacheWriteTokens ?? 0,
			event.outputTokens ?? 0,
			now,
			event.conversationId,
		],
	};
}

/**
 * Turns this user has had this week. One indexed count — this is the question
 * a quota check asks, and it is asked before every turn.
 */
export async function turnsThisWeek(
	db: D1Database,
	userId: string,
	at: string | Date = new Date()
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM usage_events
			  WHERE user_id = ? AND billing_week = ? AND kind = 'chat_turn'`
		)
		.bind(userId, billingWeek(at))
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Midnight UTC on Monday, when the count starts again. */
export function weekResetsAt(at: string | Date = new Date()): string {
	const now = new Date(typeof at === 'string' ? at : at.toISOString());
	return new Date(
		Date.UTC(
			now.getUTCFullYear(),
			now.getUTCMonth(),
			now.getUTCDate() - ((now.getUTCDay() + 6) % 7) + 7
		)
	).toISOString();
}

/**
 * The live allowance per plan: the `settings` row if there is one, the
 * constants otherwise. Free is derived from Paid rather than stored, so the
 * ratio the free tier is described by cannot drift when Paid is tuned.
 *
 * A bad or missing row falls back rather than throwing. This is read on the
 * way into every turn, and a typo in a settings table must never be the reason
 * nobody can ask a question.
 */
export async function allowanceFor(
	db: D1Database
): Promise<Record<UserPlan, number>> {
	let paid: number = TURNS_PER_WEEK.paid;
	try {
		const row = await db
			.prepare(`SELECT value FROM settings WHERE key = ?`)
			.bind(PAID_TURNS_PER_WEEK_KEY)
			.first<{ value: string }>();
		const set = Number(row?.value);
		if (Number.isInteger(set) && set > 0) paid = set;
	} catch (error) {
		console.error(
			'[limits] the allowance setting could not be read',
			error
		);
	}
	return { paid, free: Math.max(1, Math.round(paid * FREE_SHARE_OF_PAID)) };
}

export interface Entitlement {
	plan: UserPlan;
	/** A visitor who has not signed in: `used` and `limit` are for ever, not a week. */
	guest: boolean;
	/** Turns taken this week, or ever for a guest. */
	used: number;
	/** null when unlimited, which is the admin and nobody else. */
	limit: number | null;
	/** null for a guest, whose questions never come back. */
	resets_at: string | null;
}

export const hasTurnsLeft = (e: Entitlement): boolean =>
	e.limit === null || e.used < e.limit;

/**
 * What a reader may still do this week, in one query.
 *
 * Plan is read per request rather than carried on the session: a session lasts
 * twelve hours, and somebody who has just paid should not wait out the rest of
 * one. The count comes from the same query, so the whole check costs one of
 * the fifty a request is allowed — the allowance itself is a second, and is
 * the price of being able to move it without a deploy.
 *
 * An admin has no limit. The bill is already theirs, and a cap on the person
 * paying for the models protects nobody.
 */
export async function entitlementFor(
	db: D1Database,
	userId: string,
	role: UserRole,
	at: string | Date = new Date()
): Promise<Entitlement> {
	const [row, allowance] = await Promise.all([
		db
			.prepare(
				`SELECT u.plan AS plan, u.is_guest AS is_guest,
				        (SELECT COUNT(*) FROM usage_events e
				          WHERE e.user_id = u.id
				            AND (u.is_guest = 1 OR e.billing_week = ?)
				            AND e.kind = 'chat_turn') AS used
				   FROM users u
				  WHERE u.id = ?`
			)
			.bind(billingWeek(at), userId)
			.first<{ plan: UserPlan; is_guest: number; used: number }>(),
		allowanceFor(db),
	]);

	const plan = row?.plan ?? 'free';
	const guest = row?.is_guest === 1;
	return {
		plan: guest ? 'free' : plan,
		guest,
		used: row?.used ?? 0,
		limit: role === 'admin' ? null : guest ? GUEST_TURNS : allowance[plan],
		resets_at: guest ? null : weekResetsAt(at),
	};
}
