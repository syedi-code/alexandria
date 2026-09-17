import { Hono } from 'hono';
import {
	Env,
	QuoteInput,
	QuotePatch,
	ConnectionInput,
	friendlyZodError,
} from '@alexandria/core';
import type { AuthContext } from '@alexandria/core';
import {
	createQuote,
	getQuotes,
	getQuoteById,
	updateQuote,
	deleteQuote,
} from '@alexandria/core';
import { requireAuth } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// GET /quotes
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
	const book_id = c.req.query('book_id') || undefined;
	const latestOnlyParam = c.req.query('latest_only');
	const latest_only = latestOnlyParam === '1' || latestOnlyParam === 'true';

	try {
		const quotes = await getQuotes(
			db,
			{
				limit,
				offset,
				search,
				posted:
					posted !== null && posted !== undefined
						? Number(posted)
						: undefined,
				book_id,
				latest_only,
			},
			userId
		);
		return c.json({ quotes });
	} catch (error) {
		console.error('GET /quotes error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /quotes/:id
app.get('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const id = c.req.param('id');
	try {
		const quote = await getQuoteById(db, id, userId);
		if (!quote) {
			return c.json({ error: 'Quote not found' }, 404);
		}
		return c.json({ quote });
	} catch (error) {
		console.error('GET /quotes/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /quotes
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

	const result = QuoteInput.safeParse(body);
	if (!result.success) {
		return c.json(
			{ error: 'Validation failed', details: result.error },
			400
		);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		const connections: ConnectionInput[] | undefined = body.connections;
		const quote = await createQuote(db, result.data, connections, userId);
		return c.json({ ok: true, quote }, 201);
	} catch (error) {
		console.error('POST /quotes error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// PATCH /quotes/:id
app.patch('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing quote ID' }, 400);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const parsed = QuotePatch.safeParse(body);
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
		await updateQuote(db, id, parsed.data, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('PATCH /quotes/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// DELETE /quotes/:id
app.delete('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing quote ID' }, 400);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		await deleteQuote(db, id, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('DELETE /quotes/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
