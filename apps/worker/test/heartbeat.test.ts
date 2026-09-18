import { describe, it, expect } from 'vitest';
import { withHeartbeat } from '../api/conversations/chat.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A stream that emits each chunk after its delay, then closes. */
function paced(chunks: { after: number; text: string }[]) {
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const chunk of chunks) {
				await new Promise((resolve) =>
					setTimeout(resolve, chunk.after)
				);
				controller.enqueue(encoder.encode(chunk.text));
			}
			controller.close();
		},
	});
}

async function readAll(stream: ReadableStream<Uint8Array>) {
	const out: string[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return out;
		out.push(decoder.decode(value));
	}
}

describe('withHeartbeat', () => {
	it('passes a busy stream through untouched', async () => {
		const out = await readAll(
			withHeartbeat(
				paced([
					{ after: 0, text: 'a' },
					{ after: 0, text: 'b' },
				]),
				50
			)
		);
		expect(out.join('')).toBe('ab');
	});

	it('writes a comment into a silence, then the real chunk', async () => {
		const out = await readAll(
			withHeartbeat(paced([{ after: 60, text: 'late' }]), 20)
		);
		expect(
			out.filter((part) => part.startsWith(':')).length
		).toBeGreaterThan(0);
		expect(out.at(-1)).toBe('late');
	});

	// The comment has to be one the far end throws away rather than parses.
	it('sends the heartbeat as an SSE comment', async () => {
		const out = await readAll(
			withHeartbeat(paced([{ after: 40, text: 'x' }]), 10)
		);
		const ping = out.find((part) => part.startsWith(':'));
		expect(ping).toBe(': keep-alive\n\n');
	});

	it('closes when the source closes', async () => {
		const out = await readAll(withHeartbeat(paced([]), 10));
		expect(out).toEqual([]);
	});
});
