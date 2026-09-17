import { Hono } from 'hono';
import {
	Env,
	MediaInput,
	MediaPatch,
	friendlyZodError,
} from '@alexandria/core';
import type { AuthContext } from '@alexandria/core';
import {
	createMedia,
	getMediaList,
	getMediaById,
	updateMedia,
	deleteMedia,
} from '@alexandria/core';
import { requireAuth } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// GET /media
app.get('/', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const limit = Number(c.req.query('limit')) || 50;
	const offset = Number(c.req.query('offset')) || 0;
	const search = c.req.query('search') || undefined;
	const kind = c.req.query('kind') || undefined;

	try {
		const media = await getMediaList(
			db,
			{ limit, offset, search, kind },
			userId
		);
		return c.json({ media });
	} catch (error) {
		console.error('GET /media error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /media/:id
app.get('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const id = c.req.param('id');
	try {
		const item = await getMediaById(db, id, userId);
		if (!item) {
			return c.json({ error: 'Media not found' }, 404);
		}
		return c.json({ media: item });
	} catch (error) {
		console.error('GET /media/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /media
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

	const result = MediaInput.safeParse(body);
	if (!result.success) {
		return c.json(
			{ error: 'Validation failed', details: result.error },
			400
		);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		const item = await createMedia(db, result.data, userId);
		return c.json({ ok: true, media: item }, 201);
	} catch (error) {
		console.error('POST /media error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// PATCH /media/:id
app.patch('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing media ID' }, 400);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const parsed = MediaPatch.safeParse(body);
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
		await updateMedia(db, id, parsed.data, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('PATCH /media/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// DELETE /media/:id
app.delete('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing media ID' }, 400);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		await deleteMedia(db, id, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('DELETE /media/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
