import { Hono } from 'hono';
import type { Env } from '@alexandria/core/platform';
import {
	listReadableWorks,
	MAX_READABLE_WORKS_LIMIT,
} from '@alexandria/core/works';

/**
 * The one unauthenticated read in the API, and the only thing the catalogue
 * page at `/` needs.
 *
 * It answers a bibliography — what the library holds — and nothing else. No
 * bucket keys, no page text, no writing. Opening a file still means a session
 * and a signed URL, so turning this on cannot expose a document.
 *
 * Off unless PUBLIC_CATALOGUE is "true", because a reading list is a personal
 * thing to publish and a fork should have to decide it deliberately. When it
 * is off the route 404s rather than 403s: a closed deployment does not
 * advertise what it is not serving.
 */
const app = new Hono<{ Bindings: Env }>();

app.get('/catalogue', async (c) => {
	if (c.env.PUBLIC_CATALOGUE !== 'true') {
		return c.json({ error: 'Not found' }, 404);
	}

	const works = await listReadableWorks(c.env.DB, {
		limit: MAX_READABLE_WORKS_LIMIT,
	});

	// Documents exist before their upload does; the index is of files.
	const held = works
		.map((work) => ({
			...work,
			documents: work.documents.filter((d) => d.has_file),
		}))
		.filter((work) => work.documents.length > 0);

	// The catalogue changes when a book is added, which is rarely. A minute of
	// edge caching absorbs a reload without making a stale page likely.
	c.header('Cache-Control', 'public, max-age=60');
	return c.json({ works: held });
});

export default app;
