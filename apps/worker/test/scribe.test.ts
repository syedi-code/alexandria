import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { APICallError } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { Env } from '@alexandria/core/platform';
import { listDocuments, writeTextLayer } from '@alexandria/core/works';
import {
	createConversation,
	getConversation,
	listMessages,
	type ConversationRow,
} from '@alexandria/core/conversations';
import {
	catalogueTestDatabase,
	ids,
} from '../../../packages/core/test/fixture.js';
import type { TestDatabase } from '../../../packages/core/test/d1.js';
import {
	MAX_STEPS,
	streamTurn,
	type ScribeMessage,
} from '../api/conversations/chat.js';
import type { ModelEntry } from '../api/conversations/models.js';
import { createAlexandriaMcp } from '../api/mcp/server.js';
import mcpRoutes from '../api/mcp/index.js';

let db: TestDatabase;
let documentId: string;

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
			'He who fights with monsters should be careful lest he thereby become a monster.\nAnd if thou gaze long into an abyss, the abyss will also gaze into thee.',
		],
	});
});

afterEach(() => db.close());

const usage = {
	inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 20, text: 20, reasoning: 0 },
};

const toolCall = (
	toolName: string,
	input: object
): LanguageModelV4StreamPart[] => [
	{ type: 'stream-start', warnings: [] },
	{
		type: 'tool-call',
		toolCallId: `call-${toolName}`,
		toolName,
		input: JSON.stringify(input),
	},
	{
		type: 'finish',
		finishReason: { unified: 'tool-calls', raw: undefined },
		usage,
	},
];

const answer = (text: string): LanguageModelV4StreamPart[] => [
	{ type: 'stream-start', warnings: [] },
	{ type: 'text-start', id: 't' },
	{ type: 'text-delta', id: 't', delta: text },
	{ type: 'text-end', id: 't' },
	{
		type: 'finish',
		finishReason: { unified: 'stop', raw: undefined },
		usage,
	},
];

const scripted = (...steps: LanguageModelV4StreamPart[][]) =>
	new MockLanguageModelV4({
		doStream: steps.map((parts) => ({
			stream: convertArrayToReadableStream(parts),
		})),
	});

const MODEL: ModelEntry = {
	id: 'mock-model',
	label: 'Mock',
	provider: 'anthropic',
	acceptsFiles: false,
};

const question = (text: string): ScribeMessage => ({
	id: crypto.randomUUID(),
	role: 'user',
	parts: [{ type: 'text', text }],
});

async function runTurn(
	conversation: ConversationRow,
	text: string,
	model: MockLanguageModelV4,
	titleModel?: MockLanguageModelV4
) {
	const pending: Promise<unknown>[] = [];
	const response = await streamTurn({
		works: { db: db.d1 },
		conversation,
		history: await listMessages(
			db.d1,
			conversation.user_id,
			conversation.id
		),
		message: question(text),
		model: MODEL,
		languageModel: model,
		titleModel,
		waitUntil: (promise) => pending.push(promise),
	});
	const body = await response.text();
	while (pending.length) await pending.shift();
	return body;
}

describe('a chat turn', () => {
	let conversation: ConversationRow;

	beforeEach(async () => {
		conversation = await createConversation(db.d1, ids.userAdmin, {
			model_id: MODEL.id,
		});
	});

	it('reads, answers, verifies each citation, and saves the exchange', async () => {
		const model = scripted(
			toolCall('read_pages', { document_id: documentId, from: 1, to: 2 }),
			answer(
				'Nietzsche warns [P2 "He who fights with monsters should be careful lest he"] ' +
					'but never wrote [P1 "a sentence that appears nowhere in the book"].'
			)
		);
		const titleModel = new MockLanguageModelV4({
			doGenerate: {
				content: [{ type: 'text', text: 'Nietzsche on monsters' }],
				finishReason: { unified: 'stop', raw: undefined },
				usage,
				warnings: [],
			},
		});

		const body = await runTurn(
			conversation,
			'What does Nietzsche say about monsters?',
			model,
			titleModel
		);

		expect(body).toContain('"type":"data-citations"');

		const pageText = JSON.stringify(model.doStreamCalls[1].prompt);
		expect(pageText).toContain(
			'[P1] Beyond Good and Evil — Friedrich Nietzsche'
		);
		expect(pageText).toContain('[P2] Beyond Good and Evil');

		const [asked, answered] = await listMessages(
			db.d1,
			ids.userAdmin,
			conversation.id
		);
		expect(asked.role).toBe('user');
		expect(answered.role).toBe('assistant');

		const citations = db.raw
			.prepare(
				`SELECT page_no, status FROM citations WHERE message_id = ? ORDER BY page_no DESC`
			)
			.all(answered.id)
			.map((row) => ({ ...row }));
		expect(citations).toEqual([
			{ page_no: 2, status: 'verified' },
			{ page_no: 1, status: 'unverified' },
		]);

		const dataPart = answered.parts.find(
			(p) => (p as { type: string }).type === 'data-citations'
		);
		expect(dataPart).toBeDefined();

		expect(
			(await getConversation(db.d1, ids.userAdmin, conversation.id))
				?.title
		).toBe('Nietzsche on monsters');
	});

	// A model that spent every step searching used to hit the cap in the
	// middle of a tool call, and the reader was shown everything it had read
	// with nothing underneath it. The last step has the tools taken away.
	it('answers on its last step rather than running out mid-search', async () => {
		const searches = Array.from({ length: MAX_STEPS - 1 }, () =>
			toolCall('read_pages', { document_id: documentId, from: 1, to: 2 })
		);
		const model = scripted(
			...searches,
			answer('Nietzsche warns [P2 "He who fights with monsters"].')
		);

		await runTurn(conversation, 'What about monsters?', model);

		expect(model.doStreamCalls).toHaveLength(MAX_STEPS);
		for (const call of model.doStreamCalls.slice(0, -1)) {
			expect(call.toolChoice?.type).not.toBe('none');
		}

		const last = model.doStreamCalls[MAX_STEPS - 1];
		expect(last.toolChoice?.type).toBe('none');
		expect(JSON.stringify(last.prompt)).toContain('This is your last step');

		const [, answered] = await listMessages(
			db.d1,
			ids.userAdmin,
			conversation.id
		);
		expect(
			answered.parts.some((p) => (p as { type: string }).type === 'text')
		).toBe(true);
	});

	it('keeps page handles valid across turns', async () => {
		await runTurn(
			conversation,
			'Find the abyss passage.',
			scripted(
				toolCall('read_pages', { document_id: documentId, from: 2 }),
				answer('It is on the page I read.')
			)
		);

		await runTurn(
			conversation,
			'Quote it.',
			scripted(
				answer(
					'[P1 "if thou gaze long into an abyss, the abyss will also gaze"]'
				)
			)
		);

		const statuses = db.raw
			.prepare(`SELECT page_no, status FROM citations`)
			.all()
			.map((row) => ({ ...row }));
		expect(statuses).toEqual([{ page_no: 2, status: 'verified' }]);
	});

	it('tells the reader why an answer failed, and saves nothing empty', async () => {
		const outOfCredit = new MockLanguageModelV4({
			doStream: async () => {
				throw new APICallError({
					message: 'Your credit balance is too low',
					url: 'https://api.anthropic.com/v1/messages',
					requestBodyValues: {},
					statusCode: 400,
					responseBody:
						'{"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API."}}',
					isRetryable: false,
				});
			},
		});
		const titleModel = new MockLanguageModelV4();

		const body = await runTurn(
			conversation,
			'Anything?',
			outOfCredit,
			titleModel
		);

		const errors = body.match(/"type":"error"[^}]*/g) ?? [];
		expect(errors).toEqual([
			`"type":"error","errorText":"Scribe's model provider account is out of credit."`,
		]);
		expect(
			(await listMessages(db.d1, ids.userAdmin, conversation.id)).map(
				(m) => m.role
			)
		).toEqual(['user']);
		expect(titleModel.doGenerateCalls).toHaveLength(0);
	});

	it('marks a citation to a page the model never saw', async () => {
		const body = await runTurn(
			conversation,
			'Anything?',
			scripted(
				answer(
					'Surely [P4 "some words that could be anywhere at all"].'
				)
			)
		);
		expect(body).toContain('unknown_handle');
		expect(
			db.raw.prepare(`SELECT COUNT(*) AS n FROM citations`).get()
		).toEqual({ n: 0 });
	});
});

describe('the MCP server', () => {
	async function connect() {
		const server = createAlexandriaMcp({ db: db.d1 });
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		const client = new Client({ name: 'test', version: '1.0.0' });
		await client.connect(clientTransport);
		return client;
	}

	const textOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
		(result.content as { type: string; text?: string }[])
			.map((c) => c.text)
			.join('');

	it('offers the works tools, read-only, with citation rules in its instructions', async () => {
		const client = await connect();
		const { tools } = await client.listTools();

		expect(tools.map((t) => t.name).sort()).toEqual([
			'list_works',
			'read_pages',
			'search_pages',
			'verify_citation',
			'view_page',
		]);
		expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
		expect(client.getInstructions()).toContain('verify_citation');
	});

	it('reads pages and names them by document and page', async () => {
		const client = await connect();
		const result = await client.callTool({
			name: 'read_pages',
			arguments: { document_id: documentId, from: 2 },
		});
		expect(textOf(result)).toContain(
			`[document_id ${documentId}, page_no 2]`
		);
		expect(textOf(result)).toContain('the abyss will also gaze into thee');
	});

	it('verifies citations for clients that cannot be post-processed', async () => {
		const client = await connect();
		const result = await client.callTool({
			name: 'verify_citation',
			arguments: {
				document_id: documentId,
				page_no: 2,
				quote: 'He who fights with monsters should be careful',
			},
		});
		expect(JSON.parse(textOf(result))).toMatchObject({
			status: 'verified',
		});
	});

	it('reports search as unavailable rather than failing when unconfigured', async () => {
		const client = await connect();
		const result = await client.callTool({
			name: 'search_pages',
			arguments: { query: 'abyss' },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('not configured');
	});

	it('rejects input that does not match the schema', async () => {
		const client = await connect();
		const result = await client.callTool({
			name: 'read_pages',
			arguments: { document_id: documentId, from: 0 },
		});
		expect(result.isError).toBe(true);
	});
});

describe('the /mcp route', () => {
	const rpc = (env: Partial<Env>, headers: Record<string, string> = {}) =>
		mcpRoutes.request(
			'/mcp',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'accept': 'application/json, text/event-stream',
					...headers,
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: {
						protocolVersion: '2025-06-18',
						capabilities: {},
						clientInfo: { name: 'test', version: '1.0.0' },
					},
				}),
			},
			{ DB: db.d1, ...env }
		);

	it('serves a stateless MCP session', async () => {
		const response = await rpc({ LOCAL_DEV: 'true' });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			result: { serverInfo: { name: 'alexandria' } },
		});
	});

	it('is closed until the service token is configured', async () => {
		expect((await rpc({})).status).toBe(503);
	});

	it('requires the Access assertion Cloudflare adds for the service token', async () => {
		const response = await rpc({
			TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
			MCP_POLICY_AUD: 'aud',
			MCP_SERVICE_TOKEN_ID: 'client-id',
		});
		expect(response.status).toBe(401);
	});
});
