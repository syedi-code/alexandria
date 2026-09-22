import { Hono } from 'hono';
import type { Env, AuthContext } from '@alexandria/core/platform';
import { getDocumentDetail, readPages } from '@alexandria/core/works';
import { adminOnlyMiddleware, requireAuth } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// GET /documents/:id — what a citation links to: the file, its work, its pagination
app.get('/documents/:id', requireAuth(), async (c) => {
	const document = await getDocumentDetail(c.env.DB, c.req.param('id'));
	if (!document) return c.json({ error: 'Document not found' }, 404);
	return c.json({ document });
});

// GET /documents/:id/pages?from=&to= — extracted text, at most five pages.
// Any page on request is the admin's; a reader reads the pages their own
// citations point at, through `/cited/:document_id/pages`.
app.get('/documents/:id/pages', requireAuth(), adminOnlyMiddleware(), async (c) => {
	const from = Number(c.req.query('from'));
	const to =
		c.req.query('to') === undefined ? undefined : Number(c.req.query('to'));
	if (
		!Number.isInteger(from) ||
		from < 1 ||
		(to !== undefined && !Number.isInteger(to))
	) {
		return c.json({ error: 'from and to must be page numbers' }, 400);
	}
	const pages = await readPages(c.env.DB, {
		document_id: c.req.param('id'),
		from,
		to,
	});
	return c.json({ pages });
});

export default app;
