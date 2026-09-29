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
	type InferUIMessageChunk,
	type UIMessage,
} from 'ai';
import {
	citationTrouble,
	omitOldToolOutputs,
	PageHandles,
	PageShelf,
	QuoteMarker,
	redactLibraryText,
	saveMessage,
	updateConversation,
	verifyAnswer,
	withCollapsedQuotes,
	type AnswerCitation,
	type ChatMessage,
	type CitationTrouble,
	type ConversationRow,
} from '@alexandria/core/conversations';
import { uncheckedTurnsThisWeek } from '@alexandria/core/platform';
import type { WorksToolContext } from '@alexandria/core/works';
import {
	answerFrom,
	asTitle,
	citeAgain,
	instructionsFor,
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
	{
		citations: AnswerCitation[];
		/** Written just before a second draft streams, so the reader is told why the first went. */
		redraft: { reason: CitationTrouble['kind'] };
		/** The second draft could not be checked either; it reaches the reader as it is. */
		unchecked: { reason: CitationTrouble['kind'] };
	}
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

const readsPages = (step: { toolCalls: readonly { toolName: string }[] }) =>
	step.toolCalls.some((call) =>
		(PAGE_TOOLS as readonly string[]).includes(call.toolName)
	);

const plus = (a?: number, b?: number) =>
	a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

/** Two passes over one turn, billed as one. Only what is saved is summed. */
function addUsage(
	a: LanguageModelUsage,
	b: LanguageModelUsage
): LanguageModelUsage {
	return {
		...a,
		inputTokens: plus(a.inputTokens, b.inputTokens),
		outputTokens: plus(a.outputTokens, b.outputTokens),
		totalTokens: plus(a.totalTokens, b.totalTokens),
		inputTokenDetails: {
			...a.inputTokenDetails,
			noCacheTokens: plus(
				a.inputTokenDetails?.noCacheTokens,
				b.inputTokenDetails?.noCacheTokens
			),
			cacheReadTokens: plus(
				a.inputTokenDetails?.cacheReadTokens,
				b.inputTokenDetails?.cacheReadTokens
			),
			cacheWriteTokens: plus(
				a.inputTokenDetails?.cacheWriteTokens,
				b.inputTokenDetails?.cacheWriteTokens
			),
		},
	};
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

/**
 * The answer as it streams, with every quotation that is on a page the model
 * read marked as a citation of it (`QuoteMarker`), and the text of each step
 * kept as it was sent — which is what is checked, and what is saved.
 */
type ScribeChunk = InferUIMessageChunk<ScribeMessage>;

class MarkedAnswer {
	private readonly markers = new Map<string, QuoteMarker>();
	/** What each step wrote, after marking. */
	readonly steps: string[] = [];
	/** Quotations of five words or more that no page shown holds, last step only. */
	unmarked = 0;

	constructor(private readonly shelf: PageShelf) {}

	*pass(chunk: ScribeChunk): Generator<ScribeChunk> {
		switch (chunk.type) {
			case 'start-step':
				this.steps.push('');
				this.unmarked = 0;
				break;
			case 'tool-output-available':
				this.shelf.addFrom(chunk.output);
				break;
			case 'text-start':
				this.markers.set(chunk.id, new QuoteMarker(this.shelf));
				break;
			case 'text-delta': {
				const delta = this.markerFor(chunk.id).push(chunk.delta);
				this.record(delta);
				if (delta) yield { ...chunk, delta };
				return;
			}
			case 'text-end': {
				const marker = this.markerFor(chunk.id);
				const rest = marker.flush();
				this.record(rest);
				this.unmarked += marker.unmarked;
				this.markers.delete(chunk.id);
				if (rest)
					yield { type: 'text-delta', id: chunk.id, delta: rest };
				break;
			}
		}
		yield chunk;
	}

	get last(): string {
		return this.steps.at(-1) ?? '';
	}

	private markerFor(id: string): QuoteMarker {
		let marker = this.markers.get(id);
		if (!marker) {
			marker = new QuoteMarker(this.shelf);
			this.markers.set(id, marker);
		}
		return marker;
	}

	private record(text: string) {
		if (!text) return;
		if (this.steps.length === 0) this.steps.push('');
		this.steps[this.steps.length - 1] += text;
	}
}

/**
 * An answer that could not be checked even after a second draft does not use
 * up a question — a few times a week. Past that it counts, so asking for
 * uncheckable answers is not a way round the allowance.
 */
const UNCOUNTED_PER_WEEK = 3;

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

	// Every page the conversation has been shown, so a quotation from an
	// earlier turn's reading is found as well as one from this turn's.
	const shelf = new PageShelf();
	for (const earlier of history) {
		for (const part of earlier.parts as {
			type?: string;
			output?: unknown;
		}[])
			if (part.type?.startsWith('tool-')) shelf.addFrom(part.output);
	}
	const answer = new MarkedAnswer(shelf);
	const question = textOf(message);
	const instructions = instructionsFor(model.provider);

	let citations: AnswerCitation[] = [];
	let usage: LanguageModelUsage | undefined;
	let failed = false;
	let unchecked = false;
	let uncounted = false;

	const stream = createUIMessageStream<ScribeMessage>({
		originalMessages: messages,
		generateId: () => crypto.randomUUID(),
		execute: async ({ writer }) => {
			const abortSignal = AbortSignal.timeout(TURN_TIMEOUT_MS);
			const onError = (error: unknown) => {
				failed = true;
				console.error('[chat] model failed:', error);
				return describeFailure(error);
			};

			const result = streamText({
				model: turn.languageModel,
				instructions,
				messages: modelMessages,
				tools,
				stopWhen: isStepCount(MAX_STEPS),
				abortSignal,
				// The breakpoint was written once and never passed here, and every
				// Anthropic step re-sent the whole turn at full price.
				prepareStep: ({ stepNumber, messages }) => ({
					messages: withCacheBreakpoint(messages),
					...(stepNumber < MAX_STEPS - 1
						? {}
						: {
								// The Anthropic provider sends `none` by deleting the
								// tools, and Claude, shown calls to tools it did not
								// have, said it had read nothing. It is asked instead;
								// a turn that still ends mid-read is answered below.
								...(model.provider === 'anthropic'
									? {}
									: { toolChoice: 'none' as const }),
								instructions: [instructions, LAST_STEP].join(
									'\n\n'
								),
							}),
				}),
			});

			for await (const chunk of result.toUIMessageStream<ScribeMessage>({
				sendFinish: false,
				onError,
			})) {
				for (const marked of answer.pass(chunk)) writer.write(marked);
			}
			// The error is already in the stream; awaiting results would raise it again.
			if (failed) return;

			usage = await result.totalUsage;
			let finishReason = await result.finishReason;
			const readThisTurn = (await result.steps).some(readsPages);

			/**
			 * One more pass, with no tools: the question, the draft if there
			 * is one, and the pages written out as text. Nothing in it
			 * depends on a tool the model can no longer call.
			 */
			const writeAgain = async (draft: string, request: string) => {
				const again = streamText({
					model: turn.languageModel,
					instructions,
					messages: withCacheBreakpoint([
						{ role: 'user', content: question },
						...(draft
							? [{ role: 'assistant' as const, content: draft }]
							: []),
						{ role: 'user', content: request },
					]),
					abortSignal,
				});
				for await (const chunk of again.toUIMessageStream<ScribeMessage>(
					{
						sendStart: false,
						sendFinish: false,
						onError,
					}
				)) {
					for (const marked of answer.pass(chunk))
						writer.write(marked);
				}
				if (failed) return false;
				usage = addUsage(usage!, await again.totalUsage);
				finishReason = await again.finishReason;
				return true;
			};

			// Out of steps in the middle of reading: nothing was written.
			if (!answer.last.trim() && readThisTurn && shelf.size > 0) {
				if (!(await writeAgain('', answerFrom(shelf.render())))) return;
			}

			// An answer whose citations cannot be read is written once more,
			// in the grammar that can be checked. The reader is told first,
			// so a draft does not vanish from under them unexplained; the
			// draft stays in the message, and is not checked.
			let draftAt = -1;
			const trouble = citationTrouble(
				answer.last,
				handles,
				readThisTurn || answer.unmarked > 0
			);
			if (trouble) {
				const draft = answer.last;
				draftAt = answer.steps.length - 1;
				writer.write({
					type: 'data-redraft',
					data: { reason: trouble.kind },
				});
				if (
					!(await writeAgain(
						draft,
						citeAgain(trouble, shelf.render(), model.provider)
					))
				)
					return;

				const still = citationTrouble(answer.last, handles, true);
				if (still) {
					unchecked = true;
					writer.write({
						type: 'data-unchecked',
						data: { reason: still.kind },
					});
				}
				console.warn('[chat] citations rewritten:', {
					model: model.id,
					trouble,
					still,
				});
			}

			citations = await verifyAnswer(
				works.db,
				handles,
				answer.steps.filter((_, at) => at !== draftAt).join('\n')
			);

			uncounted =
				unchecked &&
				(await uncheckedTurnsThisWeek(works.db, conversation.user_id)) <
					UNCOUNTED_PER_WEEK;

			if (citations.length > 0) {
				writer.write({ type: 'data-citations', data: citations });
			}
			writer.write({
				type: 'finish',
				finishReason,
				messageMetadata: {
					model_id: model.id,
					// One turn later than the count the route checked, which is
					// this turn: the reader is told what they have left, not
					// what they had.
					allowance: turn.allowance && {
						...turn.allowance,
						used: turn.allowance.used + (uncounted ? 0 : 1),
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
				uncounted,
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
