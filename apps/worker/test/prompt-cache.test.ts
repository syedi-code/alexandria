import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import type {
	LanguageModelV4Prompt,
	LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';
import { listDocuments, writeTextLayer } from '@alexandria/core/works';
import {
	createConversation,
	type ConversationRow,
} from '@alexandria/core/conversations';
import {
	catalogueTestDatabase,
	ids,
} from '../../../packages/core/test/fixture.js';
import type { TestDatabase } from '../../../packages/core/test/d1.js';
import { MAX_STEPS, streamTurn } from '../api/conversations/chat.js';
import type { ModelEntry } from '../api/conversations/models.js';

// Anthropic caches nothing unless a request marks where the prefix ends.
// `withCacheBreakpoint()` shipped tested and was never called, and Sonnet
// turns in production reported no cache reads or writes at all. These tests
// hold the request, not the helper.

let db: TestDatabase;
let documentId: string;
let conversation: ConversationRow;

const MODEL: ModelEntry = {
	id: 'claude-sonnet-5',
	label: 'Claude Sonnet 5',
	provider: 'anthropic',
	acceptsFiles: false,
	free: true,
};

beforeEach(async () => {
	db = catalogueTestDatabase();
	[{ id: documentId }] = await listDocuments(
		db.d1,
		ids.bookBeyondGoodAndEvil
	);
	await writeTextLayer(db.d1, {
		documentId,
		extractor: 'test',
		pages: [
			'Supposing that Truth is a woman — what then?',
			'He who fights with monsters should be careful lest he thereby become a monster.',
		],
	});
	conversation = await createConversation(db.d1, ids.userAdmin, {
		model_id: MODEL.id,
	});
});

afterEach(() => db.close());

async function runTurn(languageModel: LanguageModel) {
	const pending: Promise<unknown>[] = [];
	const response = await streamTurn({
		works: { db: db.d1 },
		conversation,
		history: [],
		message: {
			id: crypto.randomUUID(),
			role: 'user',
			parts: [{ type: 'text', text: 'What about monsters?' }],
		},
		model: MODEL,
		languageModel,
		waitUntil: (promise) => pending.push(promise),
	});
	const body = await response.text();
	expect(body).not.toContain('"type":"error"');
	expect(body).not.toContain('output-error');
	while (pending.length) await pending.shift();
}

const readPages = () => ({ document_id: documentId, from: 1, to: 2 });

describe('the cache breakpoint on a turn', () => {
	const usage = {
		inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 20, text: 20, reasoning: 0 },
	};
	const finish = (unified: 'tool-calls' | 'stop') =>
		({
			type: 'finish',
			finishReason: { unified, raw: undefined },
			usage,
		}) as const;
	const search = (): LanguageModelV4StreamPart[] => [
		{ type: 'stream-start', warnings: [] },
		{
			type: 'tool-call',
			toolCallId: 'call',
			toolName: 'read_pages',
			input: JSON.stringify(readPages()),
		},
		finish('tool-calls'),
	];
	const reply: LanguageModelV4StreamPart[] = [
		{ type: 'stream-start', warnings: [] },
		{ type: 'text-start', id: 't' },
		{ type: 'text-delta', id: 't', delta: 'Nietzsche warns.' },
		{ type: 'text-end', id: 't' },
		finish('stop'),
	];

	const marked = (prompt: LanguageModelV4Prompt) =>
		prompt.flatMap((message, i) =>
			message.providerOptions?.anthropic?.cacheControl ? [i] : []
		);

	it('sits on the last message of every step, and nowhere else', async () => {
		const steps = [...Array.from({ length: 3 }, search), reply];
		const model = new MockLanguageModelV4({
			doStream: steps.map((parts) => ({
				stream: convertArrayToReadableStream(parts),
			})),
		});

		await runTurn(model);

		expect(model.doStreamCalls).toHaveLength(steps.length);
		for (const { prompt } of model.doStreamCalls) {
			expect(marked(prompt)).toEqual([prompt.length - 1]);
		}
	});

	it('is still there on the last step, when the tools are taken away', async () => {
		const steps = [...Array.from({ length: MAX_STEPS - 1 }, search), reply];
		const model = new MockLanguageModelV4({
			doStream: steps.map((parts) => ({
				stream: convertArrayToReadableStream(parts),
			})),
		});

		await runTurn(model);

		const last = model.doStreamCalls[MAX_STEPS - 1];
		expect(last.toolChoice?.type).toBe('none');
		expect(marked(last.prompt)).toEqual([last.prompt.length - 1]);
	});
});

/**
 * Anthropic's streaming wire format, as much of it as the provider reads.
 * `cache_read_input_tokens` is what production never reported.
 */
function anthropicStream(
	blocks: object[],
	deltas: object[],
	stopReason: 'tool_use' | 'end_turn',
	cacheRead: number
): Response {
	const events: object[] = [
		{
			type: 'message_start',
			message: {
				id: 'msg',
				type: 'message',
				role: 'assistant',
				model: MODEL.id,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: {
					input_tokens: 10,
					output_tokens: 1,
					cache_read_input_tokens: cacheRead,
					cache_creation_input_tokens: 50,
				},
			},
		},
		...blocks.flatMap((block, index) => [
			{ type: 'content_block_start', index, content_block: block },
			{ type: 'content_block_delta', index, delta: deltas[index] },
			{ type: 'content_block_stop', index },
		]),
		{
			type: 'message_delta',
			delta: { stop_reason: stopReason, stop_sequence: null },
			usage: { output_tokens: 5 },
		},
		{ type: 'message_stop' },
	];
	const body = events
		.map(
			(e) =>
				`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`
		)
		.join('');
	return new Response(body, {
		headers: { 'content-type': 'text/event-stream' },
	});
}

describe('what is sent to Anthropic', () => {
	interface Block {
		type: string;
		cache_control?: unknown;
	}
	interface Body {
		messages: { content: Block[] | string }[];
	}

	it('marks the end of the prefix on every request, and bills the cache reads', async () => {
		const bodies: Body[] = [];
		const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return bodies.length === 1
				? anthropicStream(
						[
							{
								type: 'tool_use',
								id: 'tu',
								name: 'read_pages',
								input: {},
							},
						],
						[
							{
								type: 'input_json_delta',
								partial_json: JSON.stringify(readPages()),
							},
						],
						'tool_use',
						0
					)
				: anthropicStream(
						[{ type: 'text', text: '' }],
						[{ type: 'text_delta', text: 'Nietzsche warns.' }],
						'end_turn',
						900
					);
		};
		const model = createAnthropic({ apiKey: 'test', fetch })(MODEL.id);

		await runTurn(model);

		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			const blocks = body.messages.flatMap((m) =>
				typeof m.content === 'string' ? [] : m.content
			);
			const cached = blocks.filter((b) => b.cache_control);
			expect(cached).toHaveLength(1);
			expect(cached[0]).toBe(blocks.at(-1));
			expect(cached[0].cache_control).toEqual({ type: 'ephemeral' });
		}
		// The second request re-sends the page the first one read; that
		// page is the tail of the prefix it marks.
		expect(bodies[1].messages.at(-1)?.content).toEqual([
			expect.objectContaining({ type: 'tool_result' }),
		]);

		// Both steps are summed: the first wrote the cache, the second read it.
		const saved = await db.d1
			.prepare(
				"SELECT usage FROM messages WHERE conversation_id = ? AND role = 'assistant'"
			)
			.bind(conversation.id)
			.first<{ usage: string }>();
		expect(JSON.parse(saved?.usage ?? '{}')).toMatchObject({
			cacheReadTokens: 900,
			cacheWriteTokens: 100,
		});
		const ledger = await db.d1
			.prepare(
				'SELECT cache_read_tokens FROM usage_events WHERE conversation_id = ?'
			)
			.bind(conversation.id)
			.first<{ cache_read_tokens: number }>();
		expect(ledger?.cache_read_tokens).toBe(900);
	});
});
