import { Hono } from 'hono';
import type { Env, AuthContext } from '@alexandria/core/platform';
import { friendlyZodError } from '@alexandria/core/platform';
import {
	BookMediaInput,
	BookMediaPatch,
	getBookById,
	listBookMedia,
	createBookMedia,
	updateBookMedia,
	deleteBookMedia,
	getBookMediaById,
} from '@alexandria/core/works';
import { requireAuth, adminOnlyMiddleware } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// GET /books/:id/media
app.get('/books/:id/media', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}
	const id = c.req.param('id');
	try {
		const media = await listBookMedia(db, id);
		return c.json({ media });
	} catch (error) {
		console.error('GET /books/:id/media error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /books/:id/media — register an uploaded media row for the book
app.post('/books/:id/media', adminOnlyMiddleware(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}
	const userId = c.get('authContext')?.user.id;
	if (!userId) {
		return c.json({ error: 'Authentication required' }, 401);
	}

	const id = c.req.param('id');
	const book = await getBookById(db, id);
	if (!book) {
		return c.json({ error: 'Book not found' }, 404);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const result = BookMediaInput.safeParse(body);
	if (!result.success) {
		return c.json(
			{
				error: 'Validation failed',
				details: friendlyZodError(result.error),
			},
			400
		);
	}

	try {
		const row = await createBookMedia(db, id, result.data, userId);
		return c.json({ ok: true, media: row }, 201);
	} catch (error) {
		console.error('POST /books/:id/media error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// PATCH /books/:id/media/:mediaId — update caption / sort_order
app.patch('/books/:id/media/:mediaId', adminOnlyMiddleware(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const bookId = c.req.param('id');
	const mediaId = c.req.param('mediaId');
	const existing = await getBookMediaById(db, mediaId);
	if (!existing || existing.book_id !== bookId) {
		return c.json({ error: 'Media not found' }, 404);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const parsed = BookMediaPatch.safeParse(body);
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
		await updateBookMedia(db, mediaId, parsed.data);
		return c.json({ ok: true });
	} catch (error) {
		console.error('PATCH /books/:id/media/:mediaId error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// DELETE /books/:id/media/:mediaId — also remove R2 object
app.delete('/books/:id/media/:mediaId', adminOnlyMiddleware(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const bookId = c.req.param('id');
	const mediaId = c.req.param('mediaId');
	const existing = await getBookMediaById(db, mediaId);
	if (!existing || existing.book_id !== bookId) {
		return c.json({ error: 'Media not found' }, 404);
	}

	try {
		await deleteBookMedia(db, mediaId);
		const bucket = c.env.R2_BUCKET;
		if (bucket && existing.path) {
			try {
				await bucket.delete(existing.path);
			} catch (r2err) {
				console.error('R2 delete failed:', r2err);
			}
		}
		return c.json({ ok: true });
	} catch (error) {
		console.error('DELETE /books/:id/media/:mediaId error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
