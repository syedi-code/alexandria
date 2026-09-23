import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
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
import { streamTurn } from '../api/conversations/chat.js';
import type { ModelEntry } from '../api/conversations/models.js';

// On 22 September Claude Sonnet 5 answered with its quotations unmarked and a
// bare `(P14)` after each, and nothing was checked. An answer whose citations
// cannot be read is now written once more, in the grammar that can be.

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

const usage = {
	inputTokens: { total: 100, noCache: 40, cacheRead: 50, cacheWrite: 10 },
	outputTokens: { total: 20, text: 20, reasoning: 0 },
};

const finish = (unified: 'tool-calls' | 'stop') =>
	({
		type: 'finish',
		finishReason: { unified, raw: undefined },
		usage,
	}) as const;

const read = (): LanguageModelV4StreamPart[] => [
	{ type: 'stream-start', warnings: [] },
	{
		type: 'tool-call',
		toolCallId: 'read',
		toolName: 'read_pages',
		input: JSON.stringify({ document_id: documentId, from: 1, to: 2 }),
	},
	finish('tool-calls'),
];

const answer = (text: string): LanguageModelV4StreamPart[] => [
	{ type: 'stream-start', warnings: [] },
	{ type: 'text-start', id: 't' },
	{ type: 'text-delta', id: 't', delta: text },
	{ type: 'text-end', id: 't' },
	finish('stop'),
];

const BARE =
	'He warns that whoever fights with monsters should be careful lest he thereby become a monster (P2).';
const CITED =
	'He warns that <cite P2>He who fights with monsters should be careful</cite> lest he become one.';

const scripted = (...steps: LanguageModelV4StreamPart[][]) =>
	new MockLanguageModelV4({
		doStream: steps.map((parts) => ({
			stream: convertArrayToReadableStream(parts),
		})),
	});

async function runTurn(model: MockLanguageModelV4) {
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
		languageModel: model,
		waitUntil: (promise) => pending.push(promise),
	});
	const body = await response.text();
	while (pending.length) await pending.shift();
	return body;
}

async function saved() {
	const row = await db.d1
		.prepare(
			"SELECT id, parts, usage FROM messages WHERE conversation_id = ? AND role = 'assistant'"
		)
		.bind(conversation.id)
		.first<{ id: string; parts: string; usage: string }>();
	const { results: citations } = await db.d1
		.prepare('SELECT quote, status FROM citations WHERE message_id = ?')
		.bind(row?.id)
		.all<{ quote: string; status: string }>();
	const texts = (
		JSON.parse(row?.parts ?? '[]') as { type: string; text?: string }[]
	)
		.filter((part) => part.type === 'text')
		.map((part) => part.text);
	return { texts, citations, usage: JSON.parse(row?.usage ?? '{}') };
}

const lastUserText = (model: MockLanguageModelV4) =>
	JSON.stringify(model.doStreamCalls.at(-1)?.prompt.at(-1));

describe('an answer whose citations cannot be read', () => {
	it('is written again when it names a handle outside a cite', async () => {
		const model = scripted(read(), answer(BARE), answer(CITED));

		await runTurn(model);

		expect(model.doStreamCalls).toHaveLength(3);
		const repair = model.doStreamCalls[2];
		expect(repair.toolChoice?.type).toBe('none');
		expect(lastUserText(model)).toContain('P2');
		expect(lastUserText(model)).toContain('<cite P7>');

		// The rewrite is the answer, and its citation was checked.
		const { texts, citations } = await saved();
		expect(texts.at(-1)).toBe(CITED);
		expect(citations).toEqual([
			{
				quote: 'He who fights with monsters should be careful',
				status: 'verified',
			},
		]);
	});

	it('is written again when it read pages and cited none of them', async () => {
		const model = scripted(
			read(),
			answer('He warns against becoming what one fights.'),
			answer(CITED)
		);

		await runTurn(model);

		expect(model.doStreamCalls).toHaveLength(3);
		expect(lastUserText(model)).toContain('quotes none of them');
		expect((await saved()).citations).toHaveLength(1);
	});

	it('is checked in its rewrite only, so no citation is counted twice', async () => {
		const model = scripted(
			read(),
			answer(`${CITED} And the truth is a woman (P1).`),
			answer(CITED)
		);

		await runTurn(model);

		expect(model.doStreamCalls).toHaveLength(3);
		expect((await saved()).citations).toHaveLength(1);
	});

	it('is written again only once', async () => {
		const model = scripted(read(), answer(BARE), answer(BARE));

		const body = await runTurn(model);

		expect(model.doStreamCalls).toHaveLength(3);
		expect(body).not.toContain('"type":"error"');
		expect((await saved()).citations).toEqual([]);
	});

	it('is billed as one turn, both passes counted', async () => {
		await runTurn(scripted(read(), answer(BARE), answer(CITED)));

		const { usage: stored } = await saved();
		expect(stored).toMatchObject({
			inputTokens: 300,
			outputTokens: 60,
			cacheReadTokens: 150,
			cacheWriteTokens: 30,
		});
		const { results } = await db.d1
			.prepare(
				'SELECT input_tokens, cache_read_tokens FROM usage_events WHERE conversation_id = ?'
			)
			.bind(conversation.id)
			.all();
		expect(results).toEqual([
			{ input_tokens: 300, cache_read_tokens: 150 },
		]);
	});
});

describe('an answer left as it is', () => {
	it('cites what it read', async () => {
		const model = scripted(read(), answer(CITED));
		await runTurn(model);
		expect(model.doStreamCalls).toHaveLength(2);
	});

	it('read nothing, and so cites nothing', async () => {
		const model = scripted(answer('The library holds no Spinoza.'));
		await runTurn(model);
		expect(model.doStreamCalls).toHaveLength(1);
	});
});
