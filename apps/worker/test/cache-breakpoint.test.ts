import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { withCacheBreakpoint } from '../api/conversations/chat.js';

const breakpointsIn = (messages: ModelMessage[]) =>
	messages.filter((m) => m.providerOptions?.anthropic?.cacheControl).length;

const conversation = (): ModelMessage[] => [
	{ role: 'user', content: 'What does Nietzsche say about truth?' },
	{
		role: 'assistant',
		content: [
			{
				type: 'tool-call',
				toolCallId: 't1',
				toolName: 'search_pages',
				input: { query: 'truth' },
			},
		],
	},
	{
		role: 'tool',
		content: [
			{
				type: 'tool-result',
				toolCallId: 't1',
				toolName: 'search_pages',
				output: { type: 'json', value: [{ page_no: 1 }] },
			},
		],
	},
];

describe('withCacheBreakpoint', () => {
	it('marks the last message, and only the last', () => {
		const marked = withCacheBreakpoint(conversation());
		expect(breakpointsIn(marked)).toBe(1);
		expect(marked.at(-1)?.providerOptions?.anthropic?.cacheControl).toEqual(
			{
				type: 'ephemeral',
			}
		);
	});

	it('moves the breakpoint rather than adding one, however many steps run', () => {
		// Fourteen steps of two messages each would leave fourteen markers if
		// the old one were not cleared, and Anthropic keeps four.
		let messages = conversation();
		for (let step = 0; step < MAX_LOOP_STEPS; step++) {
			messages = withCacheBreakpoint(messages);
			messages = [...messages, ...conversation().slice(1)];
		}
		expect(breakpointsIn(withCacheBreakpoint(messages))).toBe(1);
	});

	it('leaves other provider options alone', () => {
		const messages: ModelMessage[] = [
			{
				role: 'user',
				content: 'hello',
				providerOptions: {
					anthropic: { cacheControl: { type: 'ephemeral' } },
					openai: { something: true },
				},
			},
			{ role: 'assistant', content: 'hi' },
		];
		const marked = withCacheBreakpoint(messages);
		expect(marked[0]?.providerOptions?.openai).toEqual({ something: true });
		expect(marked[0]?.providerOptions?.anthropic).toEqual({});
		expect(breakpointsIn(marked)).toBe(1);
	});

	it('does not mutate what it is given', () => {
		const original = conversation();
		withCacheBreakpoint(original);
		expect(breakpointsIn(original)).toBe(0);
	});
});

const MAX_LOOP_STEPS = 14;
