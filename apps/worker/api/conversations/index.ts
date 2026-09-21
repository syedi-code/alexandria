import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext, Entitlement, Env } from '@alexandria/core/platform';
import {
	entitlementFor,
	friendlyZodError,
	hasTurnsLeft,
} from '@alexandria/core/platform';
import {
	ConversationInput,
	ConversationPatch,
	createConversation,
	deleteConversation,
	getConversation,
	listConversations,
	listMessages,
	redactToolOutputs,
	updateConversation,
} from '@alexandria/core/conversations';
import { requireAuth } from '../auth.js';
import { streamTurn, type ScribeMessage } from './chat.js';
import {
	availableModels,
	DEFAULT_MODEL_ID,
	findModel,
	lockedModels,
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

type Ctx = { get(key: 'authContext'): AuthContext };

const userId = (c: Ctx) => c.get('authContext').user.id;
const role = (c: Ctx) => c.get('authContext').role;

/**
 * Which roster a reader sees. The admin is not on a plan, so their entitlement
 * carries no limit and they get every model whose key is set.
 */
const rosterFor = (e: Entitlement) => (e.limit === null ? 'unlimited' : e.plan);

/** What the client shows as "17 of 20 this month". Sent on every turn. */
const allowance = (e: Entitlement) => ({
	plan: e.plan,
	used: e.used,
	limit: e.limit,
	resets_at: e.resets_at,
});

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
app.get('/models', async (c) => {
	const entitlement = await entitlementFor(c.env.DB, userId(c), role(c));
	const models = availableModels(c.env, rosterFor(entitlement));
	const fallback = models.find((m) => m.id === DEFAULT_MODEL_ID) ?? models[0];
	return c.json({
		models,
		locked: lockedModels(c.env, rosterFor(entitlement)),
		default_model_id: fallback?.id ?? null,
		allowance: allowance(entitlement),
	});
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

	const entitlement = await entitlementFor(c.env.DB, userId(c), role(c));
	const modelId = body.data.model_id ?? DEFAULT_MODEL_ID;
	if (!findModel(c.env, modelId, rosterFor(entitlement))) {
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
	return c.json({
		conversation,
		messages: role(c) === 'admin' ? messages : redactToolOutputs(messages),
	});
});

// PATCH /conversations/:id
app.patch('/conversations/:id', async (c) => {
	const body = await readJson(c.req.raw, ConversationPatch);
	if ('error' in body) return c.json({ error: body.error }, 400);
	const patchEntitlement = await entitlementFor(c.env.DB, userId(c), role(c));
	if (
		body.data.model_id &&
		!findModel(c.env, body.data.model_id, rosterFor(patchEntitlement))
	) {
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

	const entitlement = await entitlementFor(c.env.DB, userId(c), role(c));
	if (!hasTurnsLeft(entitlement)) {
		return c.json(
			{
				error: `You have used all ${entitlement.limit} of this month's turns.`,
				code: 'TURN_LIMIT_REACHED',
				allowance: allowance(entitlement),
			},
			402
		);
	}

	const modelId = body.data.model_id ?? conversation.model_id;
	const model = findModel(c.env, modelId, rosterFor(entitlement));
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
		// The admin reads the library directly; everyone else gets an answer
		// about it. Applied to the stream as well as to a reload, because a
		// reader with a network tab sees the stream.
		redactToolOutput: role(c) !== 'admin',
		allowance: allowance(entitlement),
		waitUntil: (promise) => c.executionCtx.waitUntil(promise),
	});
});

export default app;
