import { Hono } from 'hono';
import { Env, LinkInput, LinkPatch, friendlyZodError } from '@alexandria/core';
import type { AuthContext } from '@alexandria/core';
import {
	createLink,
	getLinks,
	getLinkById,
	updateLink,
	deleteLink,
} from '@alexandria/core';
import { requireAuth } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// GET /links
app.get('/', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const limit = Number(c.req.query('limit')) || 50;
	const offset = Number(c.req.query('offset')) || 0;
	const search = c.req.query('search') || undefined;
	const posted = c.req.query('posted');

	try {
		const links = await getLinks(
			db,
			{
				limit,
				offset,
				search,
				posted:
					posted !== null && posted !== undefined
						? Number(posted)
						: undefined,
			},
			userId
		);
		return c.json({ links });
	} catch (error) {
		console.error('GET /links error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /links/:id
app.get('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const id = c.req.param('id');
	try {
		const link = await getLinkById(db, id, userId);
		if (!link) {
			return c.json({ error: 'Link not found' }, 404);
		}
		return c.json({ link });
	} catch (error) {
		console.error('GET /links/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /links
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

	const result = LinkInput.safeParse(body);
	if (!result.success) {
		return c.json(
			{ error: 'Validation failed', details: result.error },
			400
		);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		const link = await createLink(db, result.data, userId);
		return c.json({ ok: true, link }, 201);
	} catch (error) {
		console.error('POST /links error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// PATCH /links/:id
app.patch('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing link ID' }, 400);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const parsed = LinkPatch.safeParse(body);
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
		await updateLink(db, id, parsed.data, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('PATCH /links/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// DELETE /links/:id
app.delete('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing link ID' }, 400);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		await deleteLink(db, id, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('DELETE /links/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
