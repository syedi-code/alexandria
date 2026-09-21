/// <reference types="@cloudflare/workers-types" />
import { TURNS_PER_MONTH } from './limits.js';
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
		          id, user_id, billing_month, kind, model_id, conversation_id,
		          message_id, input_tokens, cache_read_tokens,
		          cache_write_tokens, output_tokens, created_at)
		      SELECT ?, c.user_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
 * Turns this user has had this month. One indexed count — this is the question
 * a quota check asks, and it is asked before every turn.
 */
export async function turnsThisMonth(
	db: D1Database,
	userId: string,
	at: string | Date = new Date()
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM usage_events
			  WHERE user_id = ? AND billing_month = ? AND kind = 'chat_turn'`
		)
		.bind(userId, billingMonth(at))
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Midnight UTC on the first of next month, when the count starts again. */
export function monthResetsAt(at: string | Date = new Date()): string {
	const now = new Date(typeof at === 'string' ? at : at.toISOString());
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
	).toISOString();
}

export interface Entitlement {
	plan: UserPlan;
	/** Turns taken this month. */
	used: number;
	/** null when unlimited, which is the admin and nobody else. */
	limit: number | null;
	resets_at: string;
}

export const hasTurnsLeft = (e: Entitlement): boolean =>
	e.limit === null || e.used < e.limit;

/**
 * What a reader may still do this month, in one query.
 *
 * Plan is read per request rather than carried on the session: a session lasts
 * twelve hours, and somebody who has just paid should not wait out the rest of
 * one. The count comes from the same query, so the whole check costs one of
 * the fifty a request is allowed.
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
	const row = await db
		.prepare(
			`SELECT u.plan AS plan,
			        (SELECT COUNT(*) FROM usage_events e
			          WHERE e.user_id = u.id
			            AND e.billing_month = ?
			            AND e.kind = 'chat_turn') AS used
			   FROM users u
			  WHERE u.id = ?`
		)
		.bind(billingMonth(at), userId)
		.first<{ plan: UserPlan; used: number }>();

	const plan = row?.plan ?? 'free';
	return {
		plan,
		used: row?.used ?? 0,
		limit: role === 'admin' ? null : TURNS_PER_MONTH[plan],
		resets_at: monthResetsAt(at),
	};
}
