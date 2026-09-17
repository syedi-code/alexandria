import { Hono } from 'hono';
import { z } from 'zod';
import {
	Env,
	ThreadInput,
	ThreadPatch,
	ThreadItemInput,
	ReorderItem,
	friendlyZodError,
} from '@alexandria/core';
import type { AuthContext } from '@alexandria/core';
import {
	createThread,
	updateThread,
	deleteThread,
	getThreads,
	getThreadById,
	getThreadItems,
	addThreadItem,
	removeThreadItemById,
	reorderThreadItems,
	getThreadsForEntity,
	getThreadsForEntities,
	MAX_BATCH_ENTITY_IDS,
} from '@alexandria/core';
import { requireAuth } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// GET /threads — list threads with item counts
app.get('/', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const limit = Number(c.req.query('limit')) || 100;
	const offset = Number(c.req.query('offset')) || 0;
	const search = c.req.query('search') || undefined;

	try {
		const threads = await getThreads(db, { limit, offset, search }, userId);
		return c.json({ threads });
	} catch (error) {
		console.error('GET /threads error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /threads/for-entity?type=note&id=xxx — reverse lookup
app.get('/for-entity', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const entityType = c.req.query('type');
	const entityId = c.req.query('id');

	if (!entityType || !entityId) {
		return c.json(
			{ error: 'Missing required query params: type, id' },
			400
		);
	}

	try {
		const threads = await getThreadsForEntity(
			db,
			entityType,
			entityId,
			userId
		);
		return c.json({ threads });
	} catch (error) {
		console.error('GET /threads/for-entity error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /threads/for-entities?type=note&ids=a,b,c — batched reverse lookup.
// Returns one row per (thread, entity) pair; callers group by entity_id.
app.get('/for-entities', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const entityType = c.req.query('type');
	const idsParam = c.req.query('ids');

	if (!entityType || !idsParam) {
		return c.json(
			{ error: 'Missing required query params: type, ids' },
			400
		);
	}

	const ids = idsParam
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean);
	if (ids.length === 0) {
		return c.json({ threads: [] });
	}
	if (ids.length > MAX_BATCH_ENTITY_IDS) {
		return c.json(
			{ error: `Too many ids (max ${MAX_BATCH_ENTITY_IDS})` },
			400
		);
	}

	try {
		const threads = await getThreadsForEntities(
			db,
			entityType,
			ids,
			userId
		);
		return c.json({ threads });
	} catch (error) {
		console.error('GET /threads/for-entities error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /threads/:id — single thread with items
app.get('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const id = c.req.param('id');

	try {
		const thread = await getThreadById(db, id, userId);
		if (!thread) {
			return c.json({ error: 'Thread not found' }, 404);
		}
		const items = await getThreadItems(db, id, userId);
		return c.json({ thread, items });
	} catch (error) {
		console.error('GET /threads/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /threads — create thread
app.post('/', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const result = ThreadInput.safeParse(body);
	if (!result.success) {
		return c.json(
			{ error: 'Validation failed', details: result.error },
			400
		);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		const thread = await createThread(db, result.data, userId);
		return c.json({ ok: true, thread }, 201);
	} catch (error) {
		console.error('POST /threads error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// PATCH /threads/:id — update name/description
app.patch('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const parsed = ThreadPatch.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{
				error: 'Validation failed',
				details: friendlyZodError(parsed.error),
			},
			400
		);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		await updateThread(db, id, parsed.data, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('PATCH /threads/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// DELETE /threads/:id — delete thread
app.delete('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');

	try {
		const userId = c.get('authContext')!.user.id;
		await deleteThread(db, id, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('DELETE /threads/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /threads/:id/items — add item
app.post('/:id/items', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const threadId = c.req.param('id');

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const parsed = ThreadItemInput.safeParse({ ...body, thread_id: threadId });
	if (!parsed.success) {
		return c.json(
			{
				error: 'Validation failed',
				details: friendlyZodError(parsed.error),
			},
			400
		);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		const item = await addThreadItem(
			db,
			threadId,
			parsed.data.entity_type,
			parsed.data.entity_id,
			userId
		);
		return c.json({ ok: true, item }, 201);
	} catch (error) {
		console.error('POST /threads/:id/items error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// DELETE /threads/:id/items/:itemId — remove item
app.delete('/:id/items/:itemId', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const threadId = c.req.param('id');
	const itemId = c.req.param('itemId');

	try {
		const userId = c.get('authContext')!.user.id;
		await removeThreadItemById(db, threadId, itemId, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('DELETE /threads/:id/items/:itemId error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// PUT /threads/:id/items/reorder — batch reorder
app.put('/:id/items/reorder', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const threadId = c.req.param('id');

	let body: { items?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	if (!body.items || !Array.isArray(body.items)) {
		return c.json({ error: 'Missing required field: items (array)' }, 400);
	}

	const parsed = z.array(ReorderItem).safeParse(body.items);
	if (!parsed.success) {
		return c.json(
			{
				error: 'Validation failed',
				details: friendlyZodError(parsed.error),
			},
			400
		);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		await reorderThreadItems(db, threadId, parsed.data, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('PUT /threads/:id/items/reorder error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
