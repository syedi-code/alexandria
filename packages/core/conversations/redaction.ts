import type { ChatMessage } from './schema.js';

/**
 * The fields of a tool result that carry the library's own words rather than
 * Scribe's: `read_pages` returns `text`, `search_pages` returns `snippet`.
 *
 * Named as fields rather than as tools on purpose. A rule written as "the page
 * tools are redacted" is a rule that stops holding the day someone adds a
 * fourth page tool and forgets the list; a rule written as "these two fields
 * never leave the server" holds for tools that do not exist yet.
 */
const LIBRARY_TEXT_FIELDS = ['text', 'snippet'] as const;

/** A tool result whose page text was removed before the client saw it. */
export interface RedactedItem {
	redacted: true;
}

export const isRedacted = (value: unknown): value is RedactedItem =>
	(value as RedactedItem)?.redacted === true;

/**
 * The same tool output with the library's text taken out and everything else
 * left alone — handles, work titles, creators, printed page numbers and refs
 * all survive, so a reader still sees which pages were consulted and can still
 * follow a citation.
 *
 * Applied only to a tool result's `output`, never to a message's parts: a text
 * part's `text` is Scribe's answer, and blanking that would delete the reply.
 */
export function redactLibraryText(output: unknown): unknown {
	if (Array.isArray(output)) return output.map(redactLibraryText);
	if (!output || typeof output !== 'object') return output;

	const source = output as Record<string, unknown>;
	let redacted = false;
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(source)) {
		if (
			(LIBRARY_TEXT_FIELDS as readonly string[]).includes(key) &&
			typeof value === 'string'
		) {
			result[key] = null;
			redacted = true;
		} else {
			result[key] = redactLibraryText(value);
		}
	}
	return redacted ? { ...result, redacted: true } : result;
}

/**
 * Every tool result in these messages, redacted. Used on the way out to a
 * client that is not the admin — both when a conversation is reloaded and as
 * the answer streams, because a reader with a network tab sees the stream.
 */
export function redactToolOutputs<M extends ChatMessage>(
	messages: readonly M[]
): M[] {
	return messages.map((message) => ({
		...message,
		parts: message.parts.map((part) => {
			const { state, output } = part as {
				state?: string;
				output?: unknown;
			};
			if (state !== 'output-available' || output === undefined)
				return part;
			return { ...(part as object), output: redactLibraryText(output) };
		}),
	})) as M[];
}
