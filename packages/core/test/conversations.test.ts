import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TestDatabase } from './d1.js';
import { catalogueTestDatabase, ids } from './fixture.js';
import { listDocuments, writeTextLayer } from '../works/index.js';
import {
	ConversationPatch,
	createConversation,
	deleteConversation,
	getConversation,
	isOmittedToolOutput,
	listConversations,
	listMessages,
	omitOldToolOutputs,
	PageHandles,
	parseCitations,
	saveMessage,
	updateConversation,
	verifyAnswer,
	type ChatMessage,
} from '../conversations/index.js';

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
			'Supposing that Truth is a woman — what then? Is there not ground for suspecting that all philosophers have failed to understand women?',
			'He who fights with monsters should be careful lest he thereby become a monster.',
		],
	});
});

afterEach(() => db.close());

const text = (
	id: string,
	role: ChatMessage['role'],
	body: string
): ChatMessage => ({
	id,
	role,
	parts: [{ type: 'text', text: body }],
});

const readPagesPart = (handles: [string, number][]) => ({
	type: 'tool-read_pages',
	toolCallId: `call-${handles[0][0]}`,
	state: 'output-available',
	input: {},
	output: handles.map(([handle, page_no]) => ({
		handle,
		ref: { document_id: documentId, page_no },
		text: 'page text',
	})),
});

describe('conversations', () => {
	it('belong to their owner and to no one else', async () => {
		const conversation = await createConversation(db.d1, ids.userAdmin, {
			model_id: 'claude-sonnet-5',
		});

		expect(
			await getConversation(db.d1, ids.userAdmin, conversation.id)
		).toEqual(conversation);
		expect(
			await getConversation(db.d1, ids.userOther, conversation.id)
		).toBeNull();
		expect(await listConversations(db.d1, ids.userOther)).toEqual([]);
		expect(
			await updateConversation(db.d1, ids.userOther, conversation.id, {
				title: 'mine now',
			})
		).toBe(false);
		expect(
			await deleteConversation(db.d1, ids.userOther, conversation.id)
		).toBe(false);
	});

	it('list by most recent activity, and a new message counts as activity', async () => {
		const older = await createConversation(db.d1, ids.userAdmin, {
			model_id: 'm',
		});
		await new Promise((r) => setTimeout(r, 5));
		const newer = await createConversation(db.d1, ids.userAdmin, {
			model_id: 'm',
		});
		await new Promise((r) => setTimeout(r, 5));
		await saveMessage(db.d1, {
			conversationId: older.id,
			message: text('m1', 'user', 'hello'),
		});

		const listed = await listConversations(db.d1, ids.userAdmin);
		expect(listed.map((c) => c.id)).toEqual([older.id, newer.id]);
		expect(
			await listConversations(db.d1, ids.userAdmin, {
				before: listed[0].updated_at,
			})
		).toEqual([expect.objectContaining({ id: newer.id })]);
	});

	it('disappear when deleted', async () => {
		const conversation = await createConversation(db.d1, ids.userAdmin, {
			model_id: 'm',
		});
		expect(
			await deleteConversation(db.d1, ids.userAdmin, conversation.id)
		).toBe(true);
		expect(
			await getConversation(db.d1, ids.userAdmin, conversation.id)
		).toBeNull();
		expect(
			await listMessages(db.d1, ids.userAdmin, conversation.id)
		).toEqual([]);
	});

	it('refuse an empty patch', () => {
		expect(ConversationPatch.safeParse({}).success).toBe(false);
		expect(ConversationPatch.safeParse({ title: 'On Truth' }).success).toBe(
			true
		);
	});
});

describe('messages', () => {
	it('keep their order and round-trip their parts exactly', async () => {
		const { id } = await createConversation(db.d1, ids.userAdmin, {
			model_id: 'm',
		});
		const question = text('q', 'user', 'What is the will to truth?');
		const answer: ChatMessage = {
			id: 'a',
			role: 'assistant',
			parts: [
				readPagesPart([['P1', 1]]),
				{ type: 'text', text: 'It is a prejudice.' },
			],
		};

		await saveMessage(db.d1, { conversationId: id, message: question });
		await saveMessage(db.d1, {
			conversationId: id,
			message: answer,
			modelId: 'm',
		});

		expect(await listMessages(db.d1, ids.userAdmin, id)).toEqual([
			question,
			answer,
		]);
		expect(await listMessages(db.d1, ids.userOther, id)).toEqual([]);
	});

	it('replace an answer that is saved again, citations included', async () => {
		const { id } = await createConversation(db.d1, ids.userAdmin, {
			model_id: 'm',
		});
		const citation = {
			handle: 'P1',
			quote: 'He who fights with monsters should be careful',
			ref: { document_id: documentId, page_no: 2 },
			status: 'verified' as const,
			matched: [{ document_id: documentId, page_no: 2 }],
		};

		await saveMessage(db.d1, {
			conversationId: id,
			message: text('a', 'assistant', 'draft'),
			citations: [citation],
		});
		await saveMessage(db.d1, {
			conversationId: id,
			message: text('a', 'assistant', 'final'),
			citations: [citation],
		});

		const messages = await listMessages(db.d1, ids.userAdmin, id);
		expect(messages).toEqual([text('a', 'assistant', 'final')]);
		expect(
			db.raw.prepare(`SELECT COUNT(*) AS n FROM citations`).get()
		).toEqual({ n: 1 });
	});
});

describe('page handles', () => {
	it('recover from stored tool results and continue numbering after them', () => {
		const handles = PageHandles.fromMessages([
			{
				id: 'a',
				role: 'assistant',
				parts: [
					readPagesPart([
						['P1', 1],
						['P3', 2],
					]),
				],
			},
		]);

		expect(handles.resolve('P3')).toEqual({
			document_id: documentId,
			page_no: 2,
		});
		expect(handles.handleFor({ document_id: documentId, page_no: 1 })).toBe(
			'P1'
		);
		expect(handles.handleFor({ document_id: documentId, page_no: 9 })).toBe(
			'P4'
		);
	});

	it('label results, giving a page the same handle every time', () => {
		const handles = new PageHandles();
		const ref = { document_id: documentId, page_no: 1 };
		const [first] = handles.label([{ ref }]);
		const [again] = handles.label([{ ref: { ...ref } }]);
		expect(first.handle).toBe('P1');
		expect(again.handle).toBe('P1');
	});
});

describe('answer citations', () => {
	it('are parsed however the model punctuates them', () => {
		expect(
			parseCitations(
				'A [P1 "straight quotes"], B [P12: “curly quotes”] and not [P2 unquoted].'
			)
		).toEqual([
			{ handle: 'P1', quote: 'straight quotes' },
			{ handle: 'P12', quote: 'curly quotes' },
		]);
	});

	it('may quote a quotation', () => {
		expect(
			parseCitations(
				'Descartes [P1 "the charter of universalism, that "reason . . . is found whole""] and [P2 "next"].'
			)
		).toEqual([
			{
				handle: 'P1',
				quote: 'the charter of universalism, that "reason . . . is found whole"',
			},
			{ handle: 'P2', quote: 'next' },
		]);
	});

	it('are found when the quote comes before a bare handle', () => {
		expect(
			parseCitations(
				'He calls it "the charter of universalism" [P1], and later “a second quote” [P3]; "not cited" P4.'
			)
		).toEqual([
			{ handle: 'P1', quote: 'the charter of universalism' },
			{ handle: 'P3', quote: 'a second quote' },
		]);
	});

	it('are verified against the page their handle names', async () => {
		const handles = new PageHandles();
		handles.handleFor({ document_id: documentId, page_no: 1 });
		handles.handleFor({ document_id: documentId, page_no: 2 });

		const citations = await verifyAnswer(
			db.d1,
			handles,
			`Nietzsche opens with a provocation [P1 "Supposing that Truth is a woman — what then?"]
			 and warns [P2 "he who fights with monsters should be careful lest he"]
			 but never says [P2 "he who fights with dragons should be careful"]
			 or anything on [P9 "a page the model was never shown at all"].`
		);

		expect(citations.map((c) => [c.handle, c.status])).toEqual([
			['P1', 'verified'],
			['P2', 'verified'],
			['P2', 'unverified'],
			['P9', 'unverified'],
		]);
		expect(citations[3]).toMatchObject({
			ref: null,
			reason: 'unknown_handle',
		});
	});
});

describe('history sent to the model', () => {
	it('drops page text from old turns but keeps the handles it carried', () => {
		const messages: ChatMessage[] = [
			text('u1', 'user', 'first'),
			{
				id: 'a1',
				role: 'assistant',
				parts: [readPagesPart([['P1', 1]])],
			},
			text('u2', 'user', 'second'),
			{
				id: 'a2',
				role: 'assistant',
				parts: [readPagesPart([['P2', 2]])],
			},
			text('u3', 'user', 'third'),
		];

		const sent = omitOldToolOutputs(messages, ['read_pages'], 2);
		const outputOf = (m: ChatMessage) =>
			(m.parts[0] as { output: unknown }).output;

		expect(isOmittedToolOutput(outputOf(sent[1]))).toBe(true);
		expect(outputOf(sent[1])).toEqual({ omitted: true, handles: ['P1'] });
		expect(outputOf(sent[3])).toEqual(outputOf(messages[3]));
		expect(isOmittedToolOutput(outputOf(messages[1]))).toBe(false);
	});
});
