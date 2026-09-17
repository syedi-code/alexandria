import { Hono } from 'hono';
import {
	Env,
	NoteInput,
	NotePatch,
	ConnectionInput,
	friendlyZodError,
} from '@alexandria/core';
import type { AuthContext } from '@alexandria/core';
import {
	createNote,
	getNotes,
	getNoteFacets,
	getShuffleNotes,
	getNoteById,
	updateNote,
	deleteNote,
} from '@alexandria/core';
import type { NoteQueryFilters, NoteSort } from '@alexandria/core';
import { requireAuth } from '../auth.js';

const NOTE_SORTS = new Set<NoteSort>(['newest', 'oldest', 'edited']);

/** Parse the filter query params shared by GET /notes and GET /notes/facets. */
function parseNoteFilters(c: {
	req: { query: (key: string) => string | undefined };
}): NoteQueryFilters {
	const posted = c.req.query('posted');
	const tags = c.req.query('tags');
	return {
		search: c.req.query('search') || undefined,
		posted:
			posted !== null && posted !== undefined && posted !== ''
				? Number(posted)
				: undefined,
		book_id: c.req.query('book_id') || undefined,
		tags: tags
			? tags
					.split(',')
					.map((t) => t.trim())
					.filter(Boolean)
			: undefined,
		from: c.req.query('from') || undefined,
		to: c.req.query('to') || undefined,
	};
}

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// GET /notes
app.get('/', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const limit = Number(c.req.query('limit')) || 50;
	const offset = Number(c.req.query('offset')) || 0;
	const sortParam = c.req.query('sort') as NoteSort | undefined;
	const sort = sortParam && NOTE_SORTS.has(sortParam) ? sortParam : undefined;

	try {
		const { data, hasMore } = await getNotes(
			db,
			{
				...parseNoteFilters(c),
				limit,
				offset,
				sort,
			},
			userId
		);
		return c.json({ notes: data, hasMore });
	} catch (error) {
		console.error('GET /notes error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /notes/facets — aggregate counts for the filter UI.
// Must be registered before GET /notes/:id so 'facets' isn't matched as an id.
app.get('/facets', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	try {
		const facets = await getNoteFacets(db, parseNoteFilters(c), userId);
		return c.json({ facets });
	} catch (error) {
		console.error('GET /notes/facets error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /notes/shuffle — weighted-random deal for shuffle mode.
// Must be registered before GET /notes/:id so 'shuffle' isn't matched as an id.
app.get('/shuffle', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const count = Number(c.req.query('count')) || 5;
	try {
		const { data, total } = await getShuffleNotes(db, { count }, userId);
		return c.json({ notes: data, total });
	} catch (error) {
		console.error('GET /notes/shuffle error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /notes/:id
app.get('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const id = c.req.param('id');
	try {
		const note = await getNoteById(db, id, userId);
		if (!note) {
			return c.json({ error: 'Note not found' }, 404);
		}
		return c.json({ note });
	} catch (error) {
		console.error('GET /notes/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /notes
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

	const result = NoteInput.safeParse(body);
	if (!result.success) {
		return c.json(
			{ error: 'Validation failed', details: result.error },
			400
		);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		const connections: ConnectionInput[] | undefined = body.connections;
		const note = await createNote(db, result.data, connections, userId);
		return c.json({ ok: true, note }, 201);
	} catch (error) {
		console.error('POST /notes error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// PATCH /notes/:id
app.patch('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing note ID' }, 400);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const parsed = NotePatch.safeParse(body);
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
		await updateNote(db, id, parsed.data, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('PATCH /notes/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// DELETE /notes/:id
app.delete('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing note ID' }, 400);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		await deleteNote(db, id, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('DELETE /notes/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
