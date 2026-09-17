/// <reference types="@cloudflare/workers-types" />
import type { ConversationPatch, ConversationRow } from './schema.js';

/**
 * Every function here is scoped by owner. A conversation that exists but
 * belongs to someone else is indistinguishable from one that doesn't exist.
 */

const COLUMNS = `id, user_id, title, model_id, created_at, updated_at`;
const UPDATABLE = ['title', 'model_id'] as const;

export async function createConversation(
	db: D1Database,
	userId: string,
	input: { model_id: string; title?: string | null }
): Promise<ConversationRow> {
	const now = new Date().toISOString();
	const row: ConversationRow = {
		id: crypto.randomUUID(),
		user_id: userId,
		title: input.title ?? null,
		model_id: input.model_id,
		created_at: now,
		updated_at: now,
	};
	await db
		.prepare(
			`INSERT INTO conversations (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`
		)
		.bind(
			row.id,
			row.user_id,
			row.title,
			row.model_id,
			row.created_at,
			row.updated_at
		)
		.run();
	return row;
}

/** Newest activity first. `before` is an `updated_at` cursor from the previous page. */
export async function listConversations(
	db: D1Database,
	userId: string,
	{ limit = 50, before }: { limit?: number; before?: string } = {}
): Promise<ConversationRow[]> {
	const { results } = await db
		.prepare(
			`SELECT ${COLUMNS} FROM conversations
			  WHERE user_id = ? AND deleted_at IS NULL
			    ${before ? 'AND updated_at < ?' : ''}
			  ORDER BY updated_at DESC
			  LIMIT ?`
		)
		.bind(
			userId,
			...(before ? [before] : []),
			Math.min(Math.max(1, limit), 100)
		)
		.all<ConversationRow>();
	return results ?? [];
}

export async function getConversation(
	db: D1Database,
	userId: string,
	id: string
): Promise<ConversationRow | null> {
	return db
		.prepare(
			`SELECT ${COLUMNS} FROM conversations
			  WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
		)
		.bind(id, userId)
		.first<ConversationRow>();
}

/** Returns false when there was no such conversation to update. */
export async function updateConversation(
	db: D1Database,
	userId: string,
	id: string,
	patch: ConversationPatch
): Promise<boolean> {
	const columns = UPDATABLE.filter((column) => patch[column] !== undefined);
	if (columns.length === 0) return false;

	const result = await db
		.prepare(
			`UPDATE conversations SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
			  WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
		)
		.bind(
			...columns.map((c) => patch[c]),
			new Date().toISOString(),
			id,
			userId
		)
		.run();
	return result.meta.changes > 0;
}

export async function deleteConversation(
	db: D1Database,
	userId: string,
	id: string
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE conversations SET deleted_at = ?
			  WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
		)
		.bind(new Date().toISOString(), id, userId)
		.run();
	return result.meta.changes > 0;
}
