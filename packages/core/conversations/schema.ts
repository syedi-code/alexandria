import { z } from 'zod';
import { MAX_LENGTHS } from '../platform/limits.js';

/**
 * The shape of an AI SDK UIMessage, as far as storage needs to know. Core does
 * not depend on the SDK; parts are stored and returned verbatim.
 */
export interface ChatMessage {
	id: string;
	role: 'system' | 'user' | 'assistant';
	parts: unknown[];
	metadata?: unknown;
}

export interface ConversationRow {
	id: string;
	user_id: string;
	title: string | null;
	model_id: string;
	created_at: string;
	updated_at: string;
}

export const ConversationInput = z.object({
	title: z.string().trim().min(1).max(MAX_LENGTHS.TITLE).optional(),
	model_id: z.string().min(1).max(MAX_LENGTHS.SHORT).optional(),
});
export type ConversationInput = z.infer<typeof ConversationInput>;

export const ConversationPatch = z
	.object({
		title: z.string().trim().min(1).max(MAX_LENGTHS.TITLE),
		model_id: z.string().min(1).max(MAX_LENGTHS.SHORT),
	})
	.partial()
	.refine((patch) => Object.keys(patch).length > 0, 'Nothing to update');
export type ConversationPatch = z.infer<typeof ConversationPatch>;

export interface MessageUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}
