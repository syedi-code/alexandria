import type { ChatMessage } from './schema.js';

/** What an old tool result becomes once its page text is no longer sent to the model. */
export interface OmittedToolOutput {
	omitted: true;
	/** Page handles the result carried; they stay valid for citing and re-reading. */
	handles: string[];
}

export function isOmittedToolOutput(
	output: unknown
): output is OmittedToolOutput {
	return (output as OmittedToolOutput)?.omitted === true;
}

function handlesIn(value: unknown, found = new Set<string>()): Set<string> {
	if (Array.isArray(value)) value.forEach((v) => handlesIn(v, found));
	else if (value && typeof value === 'object') {
		const { handle } = value as { handle?: unknown };
		if (typeof handle === 'string') found.add(handle);
		Object.values(value).forEach((v) => handlesIn(v, found));
	}
	return found;
}

/**
 * Page text is most of a conversation's tokens. Before the last `keepTurns`
 * user turns, results of the given tools are replaced with the handles they
 * carried; the model can re-read anything it needs. Stored messages are not
 * touched — this is the copy sent to the model.
 */
export function omitOldToolOutputs<M extends ChatMessage>(
	messages: readonly M[],
	toolNames: readonly string[],
	keepTurns = 2
): M[] {
	const userIndexes = messages.flatMap((m, i) =>
		m.role === 'user' ? [i] : []
	);
	const boundary = userIndexes[userIndexes.length - keepTurns] ?? 0;
	const types = new Set(toolNames.map((name) => `tool-${name}`));

	return messages.map((message, i) => {
		if (i >= boundary) return message;
		return {
			...message,
			parts: message.parts.map((part) => {
				const { type, state, output } = part as {
					type?: string;
					state?: string;
					output?: unknown;
				};
				if (!types.has(type ?? '') || state !== 'output-available')
					return part;
				const omitted: OmittedToolOutput = {
					omitted: true,
					handles: [...handlesIn(output)],
				};
				return { ...(part as object), output: omitted };
			}),
		};
	});
}
