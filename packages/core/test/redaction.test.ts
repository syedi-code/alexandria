import { describe, it, expect } from 'vitest';
import {
	redactLibraryText,
	redactToolOutputs,
	type ChatMessage,
} from '../conversations/index.js';

const searchHit = {
	handle: 'P7',
	ref: { document_id: 'doc-1', page_no: 12 },
	work_id: 'work-1',
	work_title: 'Beyond Good and Evil',
	creator: 'Friedrich Nietzsche',
	printed_page: '9',
	snippet: 'Supposing that «Truth» is a woman — what then?',
	score: -3.2,
};

const pageText = {
	handle: 'P7',
	ref: { document_id: 'doc-1', page_no: 12 },
	work_id: 'work-1',
	work_title: 'Beyond Good and Evil',
	creator: 'Friedrich Nietzsche',
	printed_page: '9',
	text: 'He who fights with monsters should be careful lest he thereby become a monster.',
};

describe('redactLibraryText', () => {
	it('takes the page text out and leaves everything a citation needs', () => {
		const [result] = redactLibraryText([pageText]) as Record<
			string,
			unknown
		>[];
		expect(result.text).toBeNull();
		expect(result.redacted).toBe(true);
		expect(result).toMatchObject({
			handle: 'P7',
			work_title: 'Beyond Good and Evil',
			creator: 'Friedrich Nietzsche',
			printed_page: '9',
			ref: { document_id: 'doc-1', page_no: 12 },
		});
	});

	it('takes the search snippet out the same way', () => {
		const [result] = redactLibraryText([searchHit]) as Record<
			string,
			unknown
		>[];
		expect(result.snippet).toBeNull();
		expect(result.score).toBe(-3.2);
		expect(result.handle).toBe('P7');
	});

	it('marks only what it actually changed', () => {
		const untouched = redactLibraryText({ handle: 'P7', page_no: 3 }) as {
			redacted?: boolean;
		};
		expect(untouched.redacted).toBeUndefined();
	});

	it('reaches text nested below the top level', () => {
		const nested = redactLibraryText({
			pages: [{ text: 'secret' }],
		}) as { pages: { text: unknown; redacted: boolean }[] };
		expect(nested.pages[0].text).toBeNull();
		expect(nested.pages[0].redacted).toBe(true);
	});

	it('leaves a null text alone rather than inventing a redaction', () => {
		const blank = redactLibraryText({ handle: 'P8', text: null }) as {
			redacted?: boolean;
		};
		expect(blank.redacted).toBeUndefined();
	});
});

describe('redactToolOutputs', () => {
	const conversation = (): ChatMessage[] => [
		{
			id: 'm1',
			role: 'assistant',
			parts: [
				{
					type: 'text',
					text: 'Nietzsche opens by asking what if truth were a woman.',
				},
				{
					type: 'tool-read_pages',
					toolCallId: 't1',
					state: 'output-available',
					input: { document_id: 'doc-1', from: 12 },
					output: [pageText],
				},
			],
		} as unknown as ChatMessage,
	];

	it("never touches Scribe's own answer", () => {
		const [message] = redactToolOutputs(conversation());
		expect((message.parts[0] as { text: string }).text).toBe(
			'Nietzsche opens by asking what if truth were a woman.'
		);
	});

	it('redacts the tool result beside it', () => {
		const [message] = redactToolOutputs(conversation());
		const output = (message.parts[1] as { output: { text: unknown }[] })
			.output;
		expect(output[0].text).toBeNull();
	});

	it('does not mutate the stored messages it was given', () => {
		const original = conversation();
		redactToolOutputs(original);
		const output = (original[0].parts[1] as { output: { text: string }[] })
			.output;
		expect(output[0].text).toContain('monsters');
	});

	it('leaves a tool call still running alone', () => {
		const running = [
			{
				id: 'm2',
				role: 'assistant',
				parts: [
					{
						type: 'tool-read_pages',
						toolCallId: 't2',
						state: 'input-available',
						input: { document_id: 'doc-1', from: 12 },
					},
				],
			},
		] as unknown as ChatMessage[];
		expect(redactToolOutputs(running)).toEqual(running);
	});
});
