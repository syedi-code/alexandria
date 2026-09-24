/// <reference types="@cloudflare/workers-types" />
import {
	insertRows,
	runStatements,
	type SqlStatement,
} from '../platform/sql.js';
import { usageEventStatement } from '../platform/usage.js';
import type { AnswerCitation } from './citations.js';
import type { ChatMessage, MessageUsage } from './schema.js';

/**
 * Writes assume the caller has already confirmed the conversation belongs to
 * the user; reads check it again, because reads are what leak.
 */

interface MessageRow {
	id: string;
	role: ChatMessage['role'];
	parts: string;
	model_id: string | null;
}

export async function listMessages(
	db: D1Database,
	userId: string,
	conversationId: string
): Promise<ChatMessage[]> {
	const { results } = await db
		.prepare(
			`SELECT m.id, m.role, m.parts, m.model_id
			   FROM messages m
			   JOIN conversations c ON c.id = m.conversation_id
			  WHERE m.conversation_id = ? AND c.user_id = ? AND c.deleted_at IS NULL
			  ORDER BY m.seq`
		)
		.bind(conversationId, userId)
		.all<MessageRow>();
	// The model rides back as the metadata the stream first gave it, so a
	// saved answer is signed by the model that wrote it, as a live one is
	// (scribe#60). A question has none.
	return (results ?? []).map((row) => ({
		id: row.id,
		role: row.role,
		parts: JSON.parse(row.parts),
		...(row.model_id && { metadata: { model_id: row.model_id } }),
	}));
}

export interface SaveMessageInput {
	conversationId: string;
	message: ChatMessage;
	modelId?: string;
	usage?: MessageUsage;
	citations?: readonly AnswerCitation[];
}

/**
 * Inserts a message, or replaces it when an answer continues an earlier
 * message with the same id. Its citations are replaced with it, and the
 * conversation moves to the top of its owner's list — all in one transaction.
 */
export function saveMessageStatements(
	input: SaveMessageInput,
	now: string
): SqlStatement[] {
	const { conversationId, message } = input;
	const citations = (input.citations ?? []).filter((c) => c.ref !== null);

	return [
		{
			sql: `INSERT INTO messages (id, conversation_id, seq, role, parts, model_id, usage, created_at)
			      VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?),
			              ?, ?, ?, ?, ?)
			      ON CONFLICT (id) DO UPDATE SET
			          parts = excluded.parts,
			          model_id = excluded.model_id,
			          usage = excluded.usage`,
			params: [
				message.id,
				conversationId,
				conversationId,
				message.role,
				JSON.stringify(message.parts),
				input.modelId ?? null,
				input.usage ? JSON.stringify(input.usage) : null,
				now,
			],
		},
		{
			sql: `DELETE FROM citations WHERE message_id = ?`,
			params: [message.id],
		},
		...insertRows(
			'citations',
			[
				'id',
				'message_id',
				'document_id',
				'page_no',
				'quote',
				'status',
				'created_at',
			],
			citations.map((c) => [
				crypto.randomUUID(),
				message.id,
				c.ref!.document_id,
				c.ref!.page_no,
				c.quote,
				c.status,
				now,
			])
		),
		{
			sql: `UPDATE conversations SET updated_at = ? WHERE id = ?`,
			params: [now, conversationId],
		},
		// Usage goes to the ledger in the same transaction that saves the
		// message, so the two can never disagree about what a turn cost.
		...(input.usage
			? [
					usageEventStatement(
						{
							kind: 'chat_turn',
							modelId: input.modelId,
							conversationId,
							messageId: message.id,
							...input.usage,
						},
						now
					),
				]
			: []),
	];
}

export async function saveMessage(
	db: D1Database,
	input: SaveMessageInput
): Promise<void> {
	await runStatements(
		db,
		saveMessageStatements(input, new Date().toISOString())
	);
}
