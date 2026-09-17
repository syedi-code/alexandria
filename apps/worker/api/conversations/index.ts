import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext, Env } from '@alexandria/core/platform';
import { friendlyZodError } from '@alexandria/core/platform';
import {
	ConversationInput,
	ConversationPatch,
	createConversation,
	deleteConversation,
	getConversation,
	listConversations,
	listMessages,
	updateConversation,
} from '@alexandria/core/conversations';
import { requireAuth } from '../auth.js';
import { streamTurn, type ScribeMessage } from './chat.js';
import {
	availableModels,
	DEFAULT_MODEL_ID,
	findModel,
	languageModel,
	titleModel,
} from './models.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

app.use('/conversations/*', requireAuth());
app.use('/conversations', requireAuth());
app.use('/models', requireAuth());

const userId = (c: { get(key: 'authContext'): AuthContext }) =>
	c.get('authContext').user.id;

async function readJson<T extends z.ZodTypeAny>(
	request: Request,
	schema: T
): Promise<{ data: z.infer<T> } | { error: string }> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return { error: 'Invalid JSON' };
	}
	const parsed = schema.safeParse(body);
	return parsed.success
		? { data: parsed.data }
		: { error: friendlyZodError(parsed.error) };
}

/** What a user may send: text only, one message at a time. History comes from the database. */
const ChatRequest = z.object({
	message: z.object({
		role: z.literal('user'),
		parts: z
			.array(
				z.object({
					type: z.literal('text'),
					text: z.string().min(1).max(20_000),
				})
			)
			.min(1)
			.max(20),
	}),
	model_id: z.string().max(200).optional(),
});

// GET /models
app.get('/models', (c) => {
	const models = availableModels(c.env);
	const fallback = models.find((m) => m.id === DEFAULT_MODEL_ID) ?? models[0];
	return c.json({ models, default_model_id: fallback?.id ?? null });
});

// GET /conversations?before=&limit=
app.get('/conversations', async (c) => {
	const conversations = await listConversations(c.env.DB, userId(c), {
		before: c.req.query('before'),
		limit: Number(c.req.query('limit')) || undefined,
	});
	return c.json({ conversations });
});

// POST /conversations
app.post('/conversations', async (c) => {
	const body = await readJson(c.req.raw, ConversationInput);
	if ('error' in body) return c.json({ error: body.error }, 400);

	const modelId = body.data.model_id ?? DEFAULT_MODEL_ID;
	if (!findModel(c.env, modelId)) {
		return c.json({ error: `Model ${modelId} is not available` }, 400);
	}
	const conversation = await createConversation(c.env.DB, userId(c), {
		model_id: modelId,
		title: body.data.title,
	});
	return c.json({ conversation }, 201);
});

// GET /conversations/:id
app.get('/conversations/:id', async (c) => {
	const id = c.req.param('id');
	const conversation = await getConversation(c.env.DB, userId(c), id);
	if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
	const messages = await listMessages(c.env.DB, userId(c), id);
	return c.json({ conversation, messages });
});

// PATCH /conversations/:id
app.patch('/conversations/:id', async (c) => {
	const body = await readJson(c.req.raw, ConversationPatch);
	if ('error' in body) return c.json({ error: body.error }, 400);
	if (body.data.model_id && !findModel(c.env, body.data.model_id)) {
		return c.json(
			{ error: `Model ${body.data.model_id} is not available` },
			400
		);
	}
	const updated = await updateConversation(
		c.env.DB,
		userId(c),
		c.req.param('id'),
		body.data
	);
	return updated
		? c.json({ ok: true })
		: c.json({ error: 'Conversation not found' }, 404);
});

// DELETE /conversations/:id
app.delete('/conversations/:id', async (c) => {
	const deleted = await deleteConversation(
		c.env.DB,
		userId(c),
		c.req.param('id')
	);
	return deleted
		? c.json({ ok: true })
		: c.json({ error: 'Conversation not found' }, 404);
});

// POST /conversations/:id/chat — streams the answer as an AI SDK UI message stream
app.post('/conversations/:id/chat', async (c) => {
	const body = await readJson(c.req.raw, ChatRequest);
	if ('error' in body) return c.json({ error: body.error }, 400);

	const id = c.req.param('id');
	const conversation = await getConversation(c.env.DB, userId(c), id);
	if (!conversation) return c.json({ error: 'Conversation not found' }, 404);

	const modelId = body.data.model_id ?? conversation.model_id;
	const model = findModel(c.env, modelId);
	if (!model)
		return c.json({ error: `Model ${modelId} is not available` }, 400);
	if (modelId !== conversation.model_id) {
		await updateConversation(c.env.DB, userId(c), id, {
			model_id: modelId,
		});
	}

	const message: ScribeMessage = {
		id: crypto.randomUUID(),
		role: 'user',
		parts: body.data.message.parts.map(({ text }) => ({
			type: 'text',
			text,
		})),
	};

	return streamTurn({
		works: { db: c.env.DB, search: c.env.SEARCH, bucket: c.env.R2_BUCKET },
		conversation: { ...conversation, model_id: modelId },
		history: await listMessages(c.env.DB, userId(c), id),
		message,
		model,
		languageModel: languageModel(c.env, model),
		titleModel: titleModel(c.env, model),
		waitUntil: (promise) => c.executionCtx.waitUntil(promise),
	});
});

export default app;
