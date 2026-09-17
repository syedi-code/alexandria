import { Hono } from 'hono';
import type { Env, AuthContext } from '@alexandria/core';
import { getLibraryBooks, getBookDetail } from '@alexandria/core/writing';
import { requireAuth } from '../auth.js';

/**
 * /books/library and /books/:id/detail live on the writing side because they
 * join works to quotes, notes and essays. The paths belong to works; the
 * queries do not. Mounted ahead of the works router so the literal
 * "library" segment is matched before the /books/:id parameter.
 */
const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// GET /books/library — enriched listing (counts, decade) + totals
app.get('/books/library', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const search = c.req.query('search') || undefined;
	const decadeRaw = c.req.query('decade') || undefined;
	const allowedDecades = new Set([
		'pre-1900',
		'1900s',
		'2000s',
		'2010s',
		'2020s',
		'unknown',
	]);
	const decade =
		decadeRaw && allowedDecades.has(decadeRaw)
			? (decadeRaw as
					| 'pre-1900'
					| '1900s'
					| '2000s'
					| '2010s'
					| '2020s'
					| 'unknown')
			: undefined;
	const hasPdfRaw = c.req.query('has_pdf');
	const hasPdf =
		hasPdfRaw === 'true' ? true : hasPdfRaw === 'false' ? false : undefined;
	const sortRaw = c.req.query('sort');
	const sort: 'author_az' | 'recent' | 'year' =
		sortRaw === 'recent' || sortRaw === 'year' ? sortRaw : 'author_az';

	try {
		const result = await getLibraryBooks(db, {
			search,
			decade,
			hasPdf,
			sort,
		});
		return c.json(result);
	} catch (error) {
		console.error('GET /books/library error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /books/:id/detail — book + author + quotes + notes + citing essays + related + media
app.get('/books/:id/detail', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	try {
		const detail = await getBookDetail(db, id);
		if (!detail) {
			return c.json({ error: 'Book not found' }, 404);
		}
		return c.json(detail);
	} catch (error) {
		console.error('GET /books/:id/detail error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
