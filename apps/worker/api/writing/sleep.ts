import { Hono } from 'hono';
import { Env, SleepInput } from '@alexandria/core';
import type { AuthContext } from '@alexandria/core';
import {
	createSleep,
	getSleepEntries,
	getSleepById,
	deleteSleep,
} from '@alexandria/core';
import { requireAuth } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// GET /sleep
app.get('/', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const limit = Number(c.req.query('limit')) || 50;
	const offset = Number(c.req.query('offset')) || 0;

	try {
		const entries = await getSleepEntries(db, { limit, offset }, userId);
		return c.json({ sleep: entries });
	} catch (error) {
		console.error('GET /sleep error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /sleep/:id
app.get('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const id = c.req.param('id');
	try {
		const entry = await getSleepById(db, id, userId);
		if (!entry) {
			return c.json({ error: 'Sleep entry not found' }, 404);
		}
		return c.json({ sleep: entry });
	} catch (error) {
		console.error('GET /sleep/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /sleep
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

	const result = SleepInput.safeParse(body);
	if (!result.success) {
		return c.json(
			{ error: 'Validation failed', details: result.error },
			400
		);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		const entry = await createSleep(db, result.data, userId);
		return c.json({ ok: true, sleep: entry }, 201);
	} catch (error) {
		console.error('POST /sleep error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// DELETE /sleep/:id
app.delete('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing sleep ID' }, 400);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		await deleteSleep(db, id, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('DELETE /sleep/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
