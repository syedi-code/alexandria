import { Hono } from 'hono';
import type { Env, AuthContext } from '@alexandria/core';
import { getAuditLogEntries } from '@alexandria/core/platform';
import { adminOnlyMiddleware } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// GET /audit/access-violations — query blocked cross-tenant access attempts
app.get('/audit/access-violations', adminOnlyMiddleware(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const limit = Number(c.req.query('limit')) || 50;
	const offset = Number(c.req.query('offset')) || 0;
	const from = c.req.query('from') || undefined;
	const to = c.req.query('to') || undefined;
	const action = c.req.query('action') as
		| 'READ'
		| 'UPDATE'
		| 'DELETE'
		| undefined;

	try {
		const { data, hasMore } = await getAuditLogEntries(db, {
			limit,
			offset,
			from,
			to,
			action,
		});
		return c.json({ entries: data, hasMore });
	} catch (error) {
		console.error('GET /audit/access-violations error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
