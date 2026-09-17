import { Hono } from 'hono';
import type { Env, AuthContext } from '@alexandria/core/platform';
import { friendlyZodError } from '@alexandria/core/platform';
import {
	AuthorInput,
	AuthorPatch,
	createCreator,
	getCreators,
	getCreatorById,
	updateCreator,
	deleteCreator,
	getBooksByAuthorId,
} from '@alexandria/core/works';
import { requireAuth, adminOnlyMiddleware } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// GET /authors
app.get('/authors', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const limit = Number(c.req.query('limit')) || 100;
	const offset = Number(c.req.query('offset')) || 0;
	const search = c.req.query('search') || undefined;

	try {
		const authors = await getCreators(db, { limit, offset, search });
		return c.json({ authors });
	} catch (error) {
		console.error('GET /authors error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /authors/:id
app.get('/authors/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	try {
		const author = await getCreatorById(db, id);
		if (!author) {
			return c.json({ error: 'Author not found' }, 404);
		}
		return c.json({ author });
	} catch (error) {
		console.error('GET /authors/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /authors
app.post('/authors', adminOnlyMiddleware(), async (c) => {
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

	const result = AuthorInput.safeParse(body);
	if (!result.success) {
		return c.json(
			{ error: 'Validation failed', details: result.error },
			400
		);
	}

	try {
		const author = await createCreator(
			db,
			result.data,
			c.get('authContext')?.user.id
		);
		return c.json({ ok: true, author }, 201);
	} catch (error) {
		console.error('POST /authors error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// PATCH /authors/:id
app.patch('/authors/:id', adminOnlyMiddleware(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing author ID' }, 400);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const parsed = AuthorPatch.safeParse(body);
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
		await updateCreator(db, id, parsed.data);
		return c.json({ ok: true });
	} catch (error) {
		console.error('PATCH /authors/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// DELETE /authors/:id
app.delete('/authors/:id', adminOnlyMiddleware(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing author ID' }, 400);
	}

	try {
		await deleteCreator(db, id);
		return c.json({ ok: true });
	} catch (error) {
		console.error('DELETE /authors/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /authors/:id/books
app.get('/authors/:id/books', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	try {
		const books = await getBooksByAuthorId(db, id);
		return c.json({ books });
	} catch (error) {
		console.error('GET /authors/:id/books error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
