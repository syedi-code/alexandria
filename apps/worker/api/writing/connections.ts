import { Hono } from 'hono';
import { Env, ConnectionInput } from '@alexandria/core';
import type { AuthContext, EntityType } from '@alexandria/core';
import {
	createConnection,
	deleteConnection,
	getConnections,
	getConnectionsOfType,
	getConnectionsForEntities,
} from '@alexandria/core';
import { requireAuth } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// GET /connections?type=note&id=xxx  — all connections for an entity
// GET /connections?type=note&id=xxx&connected_type=book  — filter by connected type
app.get('/', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const entityType = c.req.query('type');
	const entityId = c.req.query('id');
	const connectedType = c.req.query('connected_type');

	if (!entityType || !entityId) {
		return c.json(
			{ error: 'Missing required query params: type, id' },
			400
		);
	}

	try {
		const connections = connectedType
			? await getConnectionsOfType(
					db,
					entityType as EntityType,
					entityId,
					connectedType as EntityType,
					userId
				)
			: await getConnections(
					db,
					entityType as EntityType,
					entityId,
					userId
				);
		return c.json({ connections });
	} catch (error) {
		console.error('GET /connections error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /connections/for-entities?type=note&ids=a,b,c&connected_type=author
// Batched: all connections between the given entities and connected_type.
app.get('/for-entities', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const entityType = c.req.query('type');
	const idsParam = c.req.query('ids');
	const connectedType = c.req.query('connected_type');

	if (!entityType || !idsParam || !connectedType) {
		return c.json(
			{
				error: 'Missing required query params: type, ids, connected_type',
			},
			400
		);
	}

	const ids = idsParam
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean);
	if (ids.length === 0) {
		return c.json({ connections: [] });
	}
	if (ids.length > 100) {
		return c.json({ error: 'Too many ids (max 100)' }, 400);
	}

	try {
		const connections = await getConnectionsForEntities(
			db,
			entityType as EntityType,
			ids,
			connectedType as EntityType,
			userId
		);
		return c.json({ connections });
	} catch (error) {
		console.error('GET /connections/for-entities error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /connections
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

	const result = ConnectionInput.safeParse(body);
	if (!result.success) {
		return c.json(
			{ error: 'Validation failed', details: result.error },
			400
		);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		const connection = await createConnection(db, result.data, userId);
		return c.json({ ok: true, connection }, 201);
	} catch (error) {
		console.error('POST /connections error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// DELETE /connections/:id
app.delete('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');
	if (!id) {
		return c.json({ error: 'Missing connection ID' }, 400);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		await deleteConnection(db, id, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('DELETE /connections/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
