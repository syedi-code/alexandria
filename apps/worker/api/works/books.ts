import { Hono } from 'hono';
import type { Env, AuthContext } from '@alexandria/core/platform';
import { friendlyZodError } from '@alexandria/core/platform';
import {
	BookInput,
	BookPatch,
	createBook,
	getBooks,
	getBookById,
	updateBook,
	deleteBook,
} from '@alexandria/core/works';
import { requireAuth, adminOnlyMiddleware } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// GET /books
app.get('/books', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const limit = Number(c.req.query('limit')) || 100;
	const offset = Number(c.req.query('offset')) || 0;
	const search = c.req.query('search') || undefined;

	try {
		const books = await getBooks(db, { limit, offset, search });
		return c.json({ books });
	} catch (error) {
		console.error('GET /books error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /books/:id
app.get('/books/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	try {
		const book = await getBookById(db, id);
		if (!book) {
			return c.json({ error: 'Book not found' }, 404);
		}
		return c.json({ book });
	} catch (error) {
		console.error('GET /books/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /books
app.post('/books', adminOnlyMiddleware(), async (c) => {
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

	const result = BookInput.safeParse(body);
	if (!result.success) {
		return c.json(
			{ error: 'Validation failed', details: result.error },
			400
		);
	}

	try {
		const book = await createBook(
			db,
			result.data,
			c.get('authContext')?.user.id
		);
		return c.json({ ok: true, book }, 201);
	} catch (error) {
		console.error('POST /books error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// PATCH /books/:id
app.patch('/books/:id', adminOnlyMiddleware(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing book ID' }, 400);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const parsed = BookPatch.safeParse(body);
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
		await updateBook(db, id, parsed.data);
		return c.json({ ok: true });
	} catch (error) {
		console.error('PATCH /books/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// DELETE /books/:id
app.delete('/books/:id', adminOnlyMiddleware(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing book ID' }, 400);
	}

	try {
		await deleteBook(db, id);
		return c.json({ ok: true });
	} catch (error) {
		console.error('DELETE /books/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
