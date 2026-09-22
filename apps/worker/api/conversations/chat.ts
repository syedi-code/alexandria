import {
	APICallError,
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	generateText,
	isStepCount,
	RetryError,
	streamText,
	type LanguageModel,
	type LanguageModelUsage,
	type ModelMessage,
	type UIMessage,
} from 'ai';
import {
	omitOldToolOutputs,
	PageHandles,
	redactLibraryText,
	saveMessage,
	updateConversation,
	verifyAnswer,
	withCollapsedQuotes,
	type AnswerCitation,
	type ChatMessage,
	type ConversationRow,
} from '@alexandria/core/conversations';
import type { WorksToolContext } from '@alexandria/core/works';
import {
	asTitle,
	SCRIBE_INSTRUCTIONS,
	TITLE_INSTRUCTIONS,
} from './instructions.js';
import type { ModelEntry } from './models.js';
import { chatTools, PAGE_TOOLS } from './tools.js';

/** Enough to search, read around a passage and look again, without running away. */
export const MAX_STEPS = 14;

/**
 * A ceiling on one whole turn, every step of it included.
 *
 * Without this a provider that never answers holds the turn open forever: the
 * reader watches an animation that will not stop and there is no error to
 * show. Generous, because the cheap models are the slow ones — Luna can take
 * minutes to say its first word, and it pays that again on every step.
 */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How often to write a comment into a silent stream.
 *
 * Between the response headers and the model's first token, nothing is sent.
 * On a slow model that silence runs for minutes, and every hop in between —
 * Cloudflare's edge, a carrier NAT, a phone that has locked — is free to read
 * a silent connection as a dead one and close it. An SSE comment is two bytes
 * of nothing that the parser at the far end discards, and it keeps the
 * connection unambiguously alive.
 */
const HEARTBEAT_MS = 10 * 1000;

/**
 * The last step is for writing, not for reading.
 *
 * A model that spends every step searching used to hit the cap in the middle
 * of a tool call, and the turn ended with no answer at all — the reader was
 * shown a list of everything it had read and nothing underneath it. On the
 * last step the tools are taken away, so whatever it has is what it answers
 * from.
 */
const LAST_STEP = [
	'This is your last step: there are no searches or reads left.',
	'Answer now, from the pages you have already read, and cite them.',
	'If they do not settle the question, say what you found and what is',
	'still open. Do not say that you ran out of steps.',
].join(' ');

/**
 * A prefix the model has already been shown costs a tenth to show again — but
 * only up to a breakpoint, and only Anthropic wants the breakpoint marked.
 * OpenAI and Google cache the same prefixes on their own and ignore this
 * marker, so it is set for every provider and read by one.
 *
 * It moves to the end of the messages on every step, which is where the saving
 * is: a turn is up to fourteen steps, and each one re-sends every page the
 * ones before it read. Earlier markers are cleared as it moves, because
 * Anthropic keeps four breakpoints and fourteen steps would otherwise leave
 * fourteen. Moving it does not cost a re-read — the longest cached prefix is
 * still matched.
 *
 * Across turns there is nothing to cache: `omitOldToolOutputs()` rewrites the
 * history before the last two user turns, which changes the prefix every time.
 * That is the better trade — it drops the page text rather than billing a
 * tenth for it — and it is why this is not placed on the history as well.
 */
export function withCacheBreakpoint(messages: ModelMessage[]): ModelMessage[] {
	const last = messages.length - 1;
	return messages.map((message, i) => {
		const { cacheControl: _moved, ...anthropic } =
			message.providerOptions?.anthropic ?? {};
		return {
			...message,
			providerOptions: {
				...message.providerOptions,
				anthropic:
					i === last
						? { ...anthropic, cacheControl: { type: 'ephemeral' } }
						: anthropic,
			},
		} as ModelMessage;
	});
}

export type ScribeMessage = UIMessage<
	{ model_id: string; allowance?: Allowance },
	{ citations: AnswerCitation[] }
>;

/** What is left of this month, echoed back so the client can show a counter. */
export interface Allowance {
	plan: 'free' | 'paid';
	/** A visitor: three questions for ever, and none back until they sign in. */
	guest: boolean;
	used: number;
	limit: number | null;
	resets_at: string | null;
}

export interface Turn {
	works: WorksToolContext;
	conversation: ConversationRow;
	history: ChatMessage[];
	message: ScribeMessage;
	model: ModelEntry;
	languageModel: LanguageModel;
	/** Names an untitled conversation after its first question. */
	titleModel?: LanguageModel;
	/**
	 * Whether to take the library's text out of tool results on the way to this
	 * client. Applied to the encoded bytes on the way out, not to the chunks
	 * as they are written — `createUIMessageStream` builds the message it
	 * saves out of what is written, so redacting there would redact the stored
	 * copy too, and the next turn would read its own pages back blank.
	 */
	redactToolOutput?: boolean;
	/** Reported to the client with the finished answer. */
	allowance?: Allowance;
	waitUntil(promise: Promise<unknown>): void;
}

/**
 * What the reader is told when an answer fails. Provider messages are not
 * passed through; the few failures a reader can act on, or wait out, are named.
 */
export function describeFailure(error: unknown): string {
	const cause = RetryError.isInstance(error) ? error.lastError : error;
	if (cause instanceof Error && cause.name === 'TimeoutError')
		return 'The model took too long to answer and the turn was stopped.';
	if (APICallError.isInstance(cause)) {
		const { statusCode = 0, responseBody = '' } = cause;
		if (/credit balance|insufficient_quota|billing/i.test(responseBody))
			return "Scribe's model provider account is out of credit.";
		if (statusCode === 401 || statusCode === 403)
			return "Scribe's model provider rejected its API key.";
		if (statusCode === 429)
			return 'The model is receiving too many requests. Try again in a minute.';
		if (statusCode >= 500)
			return 'The model provider is unavailable right now. Try again shortly.';
	}
	return 'Scribe could not finish this answer.';
}

/** A message with nothing but step boundaries in it: the model failed before saying anything. */
const isEmpty = (message: ChatMessage) =>
	message.parts.every(
		(part) => (part as { type: string }).type === 'step-start'
	);

/**
 * The same bytes, with a comment written into every gap longer than
 * `HEARTBEAT_MS`.
 *
 * A read already in flight is kept across pulls rather than reissued — a
 * second read() on the same reader would drop whatever the first one is
 * waiting for.
 */
export function withHeartbeat(
	body: ReadableStream<Uint8Array>,
	everyMs = HEARTBEAT_MS
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const ping = new TextEncoder().encode(': keep-alive\n\n');
	let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

	return new ReadableStream({
		async pull(controller) {
			pending ??= reader.read();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const tick = new Promise<'tick'>((resolve) => {
				timer = setTimeout(() => resolve('tick'), everyMs);
			});

			try {
				const next = await Promise.race([pending, tick]);
				if (next === 'tick') {
					controller.enqueue(ping);
					return;
				}
				pending = null;
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			} finally {
				clearTimeout(timer);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

/**
 * One SSE line with any tool output in it redacted. Lines that are not data,
 * or not JSON, or not a tool result, are passed through untouched.
 */
function redactLine(line: string): string {
	if (!line.startsWith('data: ')) return line;
	let chunk: { type?: string; output?: unknown };
	try {
		chunk = JSON.parse(line.slice('data: '.length));
	} catch {
		return line;
	}
	if (chunk?.type !== 'tool-output-available') return line;
	return `data: ${JSON.stringify({
		...chunk,
		output: redactLibraryText(chunk.output),
	})}`;
}

/**
 * The same stream with the library's own text taken out of every tool result.
 *
 * It works on the encoded bytes rather than on the chunks, because the chunks
 * are also what the finished message is assembled from: redact them and the
 * saved answer loses the pages it was written from, and the turn after it
 * reads them back empty. A test holds that line.
 *
 * Whole lines only — an SSE event split across two reads is buffered until the
 * newline that ends it arrives.
 */
export function withRedactedToolOutput(
	body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const redact = (text: string) =>
		encoder.encode(text.split('\n').map(redactLine).join('\n'));
	let buffered = '';

	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffered += decoder.decode(chunk, { stream: true });
				const end = buffered.lastIndexOf('\n');
				if (end === -1) return;
				const whole = buffered.slice(0, end + 1);
				buffered = buffered.slice(end + 1);
				controller.enqueue(redact(whole));
			},
			flush(controller) {
				if (buffered) controller.enqueue(redact(buffered));
			},
		})
	);
}

async function drain(stream: ReadableStream<unknown>): Promise<void> {
	const reader = stream.getReader();
	while (!(await reader.read()).done);
}

const textOf = (message: ChatMessage) =>
	message.parts
		.flatMap((part) => {
			const { type, text } = part as { type: string; text?: string };
			return type === 'text' && text ? [text] : [];
		})
		.join('\n');

async function nameConversation(turn: Turn): Promise<void> {
	if (!turn.titleModel) return;
	const { text } = await generateText({
		model: turn.titleModel,
		instructions: TITLE_INSTRUCTIONS,
		prompt: textOf(turn.message),
	});
	const title = asTitle(text);
	if (title) {
		await updateConversation(
			turn.works.db,
			turn.conversation.user_id,
			turn.conversation.id,
			{
				title,
			}
		);
	}
}

/**
 * One exchange: save the question, let the model search and read, stream its
 * answer, verify every citation in it, and save the answer with its citations.
 *
 * Verification results reach the client as a `data-citations` part at the end
 * of the same stream. The stream is also drained on the server, so an answer
 * is saved even if the reader closes the tab halfway through.
 */
export async function streamTurn(turn: Turn): Promise<Response> {
	const { works, conversation, history, message, model } = turn;

	await saveMessage(works.db, { conversationId: conversation.id, message });

	const handles = PageHandles.fromMessages(history);
	const tools = chatTools(works, handles, model);
	const messages = [...history, message] as ScribeMessage[];
	const modelMessages = await convertToModelMessages(
		omitOldToolOutputs(messages, PAGE_TOOLS),
		{ tools, ignoreIncompleteToolCalls: true }
	);

	let citations: AnswerCitation[] = [];
	let usage: LanguageModelUsage | undefined;
	let failed = false;

	const stream = createUIMessageStream<ScribeMessage>({
		originalMessages: messages,
		generateId: () => crypto.randomUUID(),
		execute: async ({ writer }) => {
			const result = streamText({
				model: turn.languageModel,
				instructions: SCRIBE_INSTRUCTIONS,
				messages: modelMessages,
				tools,
				stopWhen: isStepCount(MAX_STEPS),
				abortSignal: AbortSignal.timeout(TURN_TIMEOUT_MS),
				// The breakpoint was written once and never passed here, and every
				// Anthropic step re-sent the whole turn at full price.
				prepareStep: ({ stepNumber, messages }) => ({
					messages: withCacheBreakpoint(messages),
					...(stepNumber < MAX_STEPS - 1
						? {}
						: {
								toolChoice: 'none' as const,
								instructions: [
									SCRIBE_INSTRUCTIONS,
									LAST_STEP,
								].join('\n\n'),
							}),
				}),
			});

			for await (const chunk of result.toUIMessageStream<ScribeMessage>({
				sendFinish: false,
				onError: (error) => {
					failed = true;
					console.error('[chat] model failed:', error);
					return describeFailure(error);
				},
			})) {
				writer.write(chunk);
			}
			// The error is already in the stream; awaiting results would raise it again.
			if (failed) return;

			const steps = await result.steps;
			citations = await verifyAnswer(
				works.db,
				handles,
				steps.map((step) => step.text).join('\n')
			);
			usage = await result.totalUsage;

			if (citations.length > 0) {
				writer.write({ type: 'data-citations', data: citations });
			}
			writer.write({
				type: 'finish',
				finishReason: await result.finishReason,
				messageMetadata: {
					model_id: model.id,
					// One turn later than the count the route checked, which is
					// this turn: the reader is told what they have left, not
					// what they had.
					allowance: turn.allowance && {
						...turn.allowance,
						used: turn.allowance.used + 1,
					},
				},
			});
		},
		onEnd: async ({ responseMessage }) => {
			if (isEmpty(responseMessage)) return;
			// A quotation the model wrote twice is written once from here on.
			// The saved copy is what the next turn reads back and what a
			// reader reloads, and both showed the passage doubled.
			await saveMessage(works.db, {
				conversationId: conversation.id,
				message: withCollapsedQuotes(responseMessage),
				modelId: model.id,
				usage: usage && {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					totalTokens: usage.totalTokens,
					cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
					cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
				},
				citations,
			});
			// Any turn that worked, not only the first. A conversation whose
			// first turn failed used to keep a null title for ever, and the
			// client sat on `naming…` for the rest of its life.
			if (!failed && !conversation.title) {
				turn.waitUntil(nameConversation(turn).catch(console.error));
			}
		},
		onError: (error) => {
			console.error('[chat] turn failed:', error);
			return describeFailure(error);
		},
	});

	const response = createUIMessageStreamResponse({
		stream,
		consumeSseStream: ({ stream: copy }) => turn.waitUntil(drain(copy)),
	});

	const redacted =
		turn.redactToolOutput && response.body
			? withRedactedToolOutput(response.body)
			: response.body;

	return new Response(redacted && withHeartbeat(redacted), response);
}
