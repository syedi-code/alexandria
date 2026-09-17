import { Hono } from 'hono';
import {
	Env,
	EssayInput,
	EssayPatch,
	ConnectionInput,
	friendlyZodError,
	parseEssayTokens,
} from '@alexandria/core';
import type { AuthContext } from '@alexandria/core';
import {
	createEssay,
	getEssays,
	getEssayById,
	updateEssay,
	deleteEssay,
	getEssayVersions,
} from '@alexandria/core';
import { requireAuth } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// GET /essays
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

	try {
		const { data, hasMore } = await getEssays(
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
			},
			userId
		);
		return c.json({ essays: data, hasMore });
	} catch (error) {
		console.error('GET /essays error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /essays/:id
app.get('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const id = c.req.param('id');

	// Handle versions sub-route
	if (id === 'versions') {
		return c.json({ error: 'Missing essay ID' }, 400);
	}

	try {
		const essay = await getEssayById(db, id, userId);
		if (!essay) {
			return c.json({ error: 'Essay not found' }, 404);
		}
		return c.json({ essay });
	} catch (error) {
		console.error('GET /essays/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /essays/:id/versions
app.get('/:id/versions', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const id = c.req.param('id');

	try {
		const versions = await getEssayVersions(db, id, userId);
		// Add version numbers (newest = highest)
		const numbered = versions.map((v, i) => ({
			...v,
			version: i + 1,
		}));
		return c.json({ versions: numbered });
	} catch (error) {
		console.error('GET /essays/:id/versions error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /essays
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

	const result = EssayInput.safeParse(body);
	if (!result.success) {
		return c.json(
			{
				error: 'Validation failed',
				details: friendlyZodError(result.error),
			},
			400
		);
	}

	// References are derived server-side from inline content tokens.
	// Anything client passed in is ignored; the worker is canonical.
	const refs = parseEssayTokens(result.data.content);

	try {
		const userId = c.get('authContext')!.user.id;
		const connections: ConnectionInput[] | undefined = body.connections;
		const essay = await createEssay(
			db,
			result.data,
			refs,
			connections,
			userId
		);
		return c.json({ ok: true, essay }, 201);
	} catch (error) {
		console.error('POST /essays error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// PATCH /essays/:id
app.patch('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing essay ID' }, 400);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const parsed = EssayPatch.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{
				error: 'Validation failed',
				details: friendlyZodError(parsed.error),
			},
			400
		);
	}

	// If the patch updates content, re-derive references from its tokens.
	// If content is unchanged, leave the existing references intact.
	const references =
		parsed.data.content !== undefined
			? parseEssayTokens(parsed.data.content)
			: undefined;

	try {
		const userId = c.get('authContext')!.user.id;
		const essay = await updateEssay(
			db,
			id,
			parsed.data,
			references,
			userId
		);
		return c.json({ ok: true, essay });
	} catch (error) {
		console.error('PATCH /essays/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// DELETE /essays/:id
app.delete('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing essay ID' }, 400);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		await deleteEssay(db, id, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('DELETE /essays/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
