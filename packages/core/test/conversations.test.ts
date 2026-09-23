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
	collapseQuotedDuplicates,
	parseCitations,
	saveMessage,
	updateConversation,
	verifyAnswer,
	type ChatMessage,
} from '../conversations/index.js';
import { billingMonth, turnsThisWeek } from '../platform/index.js';

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
	/**
	 * The words the model quotes are the citation, so an answer carries one copy
	 * of them and that copy is what is checked. Before <cite> it wrote the
	 * passage in its prose and cited it again, and the reader was shown one copy
	 * while the server checked the other.
	 */
	it('are the words a cite wraps', () => {
		expect(
			parseCitations(
				'Europe is <cite P1>a civilization that uses its principles for trickery</cite>, and <cite ref="P12">no one colonizes innocently</cite>.'
			)
		).toEqual([
			{
				handle: 'P1',
				quote: 'a civilization that uses its principles for trickery',
			},
			{ handle: 'P12', quote: 'no one colonizes innocently' },
		]);
	});

	// A quote is matched against its page character for character, so a name
	// the model marked inside one would fail a faithful citation.
	it('drop a name marked inside the quoted words', () => {
		expect(
			parseCitations(
				'<cite P4>what he cannot forgive <author>Hitler</author> for</cite>'
			)
		).toEqual([
			{ handle: 'P4', quote: 'what he cannot forgive Hitler for' },
		]);
	});

	/**
	 * Production, 19 September: every citation in the answer arrived with its
	 * quotation written out immediately before it, and the reader was shown
	 * the passage twice over.
	 */
	it('are written once when the model wrote them twice', () => {
		const answer =
			'<author>Freud</author> says that the method “considers only what occurs to the dreamer” <cite P4>considers only what occurs to the dreamer</cite>.';

		expect(collapseQuotedDuplicates(answer)).toBe(
			'<author>Freud</author> says that the method <cite P4>considers only what occurs to the dreamer</cite>.'
		);
	});

	// Every answer saved before <cite> is written in the bracketed forms, and
	// the model doubled those too.
	it('are written once in the older bracketed form', () => {
		expect(
			collapseQuotedDuplicates(
				'He concludes that “the dream is a wish-fulfilment” [P3 "the dream is a wish-fulfilment"].'
			)
		).toBe('He concludes that [P3 "the dream is a wish-fulfilment"].');
	});

	// The model has written the same words with a different stop at the end of
	// each copy. Whole runs are being compared, so the punctuation is folded.
	it('are written once though the two copies stop differently', () => {
		expect(
			collapseQuotedDuplicates(
				'He asks “who would ever have learnt how to write from a Greek?” <cite P9>who would ever have learnt how to write from a Greek!</cite>'
			)
		).toBe(
			'He asks <cite P9>who would ever have learnt how to write from a Greek!</cite>'
		);
	});

	/**
	 * The instructions already tell the model not to put quotation marks
	 * around quoted words. The day it keeps that half of the rule and still
	 * writes the words twice, a rule that looked for quotation marks would go
	 * blind — so it is the words that are compared, not the marks.
	 */
	it('are written once when the copy carried no quotation marks', () => {
		expect(
			collapseQuotedDuplicates(
				'He says that the dream is a wish-fulfilment <cite P3>the dream is a wish-fulfilment</cite>.'
			)
		).toBe('He says that <cite P3>the dream is a wish-fulfilment</cite>.');
	});

	it('are written once whatever separates the two copies', () => {
		for (const gap of [' ', ', ', '  ', ' — ', '; ']) {
			expect(
				collapseQuotedDuplicates(
					`He says “the dream is a wish-fulfilment”${gap}<cite P3>the dream is a wish-fulfilment</cite>.`
				)
			).toBe('He says <cite P3>the dream is a wish-fulfilment</cite>.');
		}
	});

	// The closing mark goes with the copy, so the opening one has to go too or
	// the reader is shown a stray asterisk where an italic used to start.
	it('take the marks the copy was opened with', () => {
		expect(
			collapseQuotedDuplicates(
				'He says **the dream is a wish-fulfilment** <cite P3>the dream is a wish-fulfilment</cite>.'
			)
		).toBe('He says <cite P3>the dream is a wish-fulfilment</cite>.');
	});

	// A short run repeats innocently; five words is what the verifier calls a
	// quote at all.
	it('leave a repeat too short to be a quotation', () => {
		const brief =
			'He says the will to truth <cite P3>the will to truth</cite>.';
		expect(collapseQuotedDuplicates(brief)).toBe(brief);
	});

	// `breathe` ends in the letters of `the`, and the run that follows it is
	// the rest of the quote. Starting there would leave the reader `brea`.
	it('never cut into the middle of a word', () => {
		const tricky =
			'He had nothing to breathe dream is a wish-fulfilment <cite P3>the dream is a wish-fulfilment</cite>.';
		expect(collapseQuotedDuplicates(tricky)).toBe(tricky);
	});

	it('leave a copy the prose has already moved on from', () => {
		const apart =
			'The dream is a wish-fulfilment was the claim <cite P3>the dream is a wish-fulfilment</cite>.';
		expect(collapseQuotedDuplicates(apart)).toBe(apart);
	});

	/**
	 * A quotation the reader meets again later in the answer is the answer
	 * re-reading it, not a copy of the citation. Pairing the two by their
	 * shared words is what scribe's anchorsFor() did, and it paired 42 of 92.
	 */
	it('leave a quotation that is not against the citation', () => {
		const answer =
			'He writes “the dream is a wish-fulfilment”, and the claim returns when he says <cite P3>the dream is a wish-fulfilment</cite>.';

		expect(collapseQuotedDuplicates(answer)).toBe(answer);
	});

	it('leave a quotation that is not the one cited', () => {
		const answer =
			'He calls it “an entirely different proposition” <cite P3>the dream is a wish-fulfilment</cite>.';

		expect(collapseQuotedDuplicates(answer)).toBe(answer);
	});

	it('take nothing out of an answer that wrote each quotation once', () => {
		const answer =
			'Europe is <cite P1>a civilization that uses its principles for trickery</cite>, and <cite P12>no one colonizes innocently</cite>.';

		expect(collapseQuotedDuplicates(answer)).toBe(answer);
	});

	it('never change which citations an answer holds', () => {
		const answer =
			'A “first quoted passage here” <cite P1>first quoted passage here</cite> and “second quoted passage here” [P2 "second quoted passage here"].';
		const collapsed = collapseQuotedDuplicates(answer);

		expect(parseCitations(collapsed)).toEqual(parseCitations(answer));
		expect(collapseQuotedDuplicates(collapsed)).toBe(collapsed);
	});

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

describe('the usage ledger', () => {
	const turn = (id: string): ChatMessage => ({
		id,
		role: 'assistant',
		parts: [{ type: 'text', text: 'An answer.' }],
	});

	it('writes one row per billed turn, billed to the conversation owner', async () => {
		const conversation = await createConversation(db.d1, ids.userAdmin, {
			model_id: 'claude-haiku-4-5-20251001',
		});
		await saveMessage(db.d1, {
			conversationId: conversation.id,
			message: turn('m1'),
			modelId: 'claude-haiku-4-5-20251001',
			usage: {
				inputTokens: 80_000,
				outputTokens: 1_000,
				cacheReadTokens: 72_000,
				cacheWriteTokens: 8_000,
			},
		});

		const row = await db.d1
			.prepare(`SELECT * FROM usage_events WHERE message_id = 'm1'`)
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({
			user_id: ids.userAdmin,
			kind: 'chat_turn',
			model_id: 'claude-haiku-4-5-20251001',
			conversation_id: conversation.id,
			input_tokens: 80_000,
			cache_read_tokens: 72_000,
			cache_write_tokens: 8_000,
			output_tokens: 1_000,
		});
		expect(row!.billing_month).toBe(billingMonth());
	});

	it('counts a user’s turns this month, and nobody else’s', async () => {
		const mine = await createConversation(db.d1, ids.userAdmin, {
			model_id: 'gpt-5.6-luna',
		});
		const theirs = await createConversation(db.d1, ids.userOther, {
			model_id: 'gpt-5.6-luna',
		});
		for (const [id, conversationId] of [
			['a', mine.id],
			['b', mine.id],
			['c', theirs.id],
		] as const) {
			await saveMessage(db.d1, {
				conversationId,
				message: turn(id),
				usage: { inputTokens: 10, outputTokens: 1 },
			});
		}

		expect(await turnsThisWeek(db.d1, ids.userAdmin)).toBe(2);
		expect(await turnsThisWeek(db.d1, ids.userOther)).toBe(1);
	});

	it('leaves no row for a turn that reported no usage', async () => {
		const conversation = await createConversation(db.d1, ids.userAdmin, {
			model_id: 'gpt-5.6-luna',
		});
		await saveMessage(db.d1, {
			conversationId: conversation.id,
			message: turn('failed'),
		});
		expect(await turnsThisWeek(db.d1, ids.userAdmin)).toBe(0);
	});

	it('does not double-count a message saved twice as it streams', async () => {
		const conversation = await createConversation(db.d1, ids.userAdmin, {
			model_id: 'gpt-5.6-luna',
		});
		for (const inputTokens of [10, 4_000]) {
			await saveMessage(db.d1, {
				conversationId: conversation.id,
				message: turn('same'),
				usage: { inputTokens, outputTokens: 1 },
			});
		}
		expect(await turnsThisWeek(db.d1, ids.userAdmin)).toBe(1);
		const row = await db.d1
			.prepare(`SELECT input_tokens FROM usage_events WHERE id = 'same'`)
			.first<{ input_tokens: number }>();
		expect(row?.input_tokens).toBe(4_000);
	});
});
