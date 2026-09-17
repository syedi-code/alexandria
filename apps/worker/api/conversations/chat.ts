import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	generateText,
	isStepCount,
	streamText,
	type LanguageModel,
	type LanguageModelUsage,
	type UIMessage,
} from 'ai';
import {
	omitOldToolOutputs,
	PageHandles,
	saveMessage,
	updateConversation,
	verifyAnswer,
	type AnswerCitation,
	type ChatMessage,
	type ConversationRow,
} from '@alexandria/core/conversations';
import type { WorksToolContext } from '@alexandria/core/works';
import { SCRIBE_INSTRUCTIONS, TITLE_INSTRUCTIONS } from './instructions.js';
import type { ModelEntry } from './models.js';
import { chatTools, PAGE_TOOLS } from './tools.js';

/** Enough to search, read around a passage and look again, without running away. */
export const MAX_STEPS = 12;

export type ScribeMessage = UIMessage<
	{ model_id: string },
	{ citations: AnswerCitation[] }
>;

export interface Turn {
	works: WorksToolContext;
	conversation: ConversationRow;
	history: ChatMessage[];
	message: ScribeMessage;
	model: ModelEntry;
	languageModel: LanguageModel;
	/** Names an untitled conversation after its first question. */
	titleModel?: LanguageModel;
	waitUntil(promise: Promise<unknown>): void;
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
	const title = text.trim().slice(0, 120);
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
			});

			for await (const chunk of result.toUIMessageStream<ScribeMessage>({
				sendFinish: false,
			})) {
				writer.write(chunk);
			}

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
				messageMetadata: { model_id: model.id },
			});
		},
		onEnd: async ({ responseMessage }) => {
			await saveMessage(works.db, {
				conversationId: conversation.id,
				message: responseMessage,
				modelId: model.id,
				usage: usage && {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					totalTokens: usage.totalTokens,
				},
				citations,
			});
			if (!conversation.title && history.length === 0) {
				turn.waitUntil(nameConversation(turn).catch(console.error));
			}
		},
		onError: (error) => {
			console.error('[chat] turn failed:', error);
			return 'Scribe could not finish this answer.';
		},
	});

	return createUIMessageStreamResponse({
		stream,
		consumeSseStream: ({ stream: copy }) => turn.waitUntil(drain(copy)),
	});
}
