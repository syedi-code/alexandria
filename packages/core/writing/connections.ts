/// <reference types="@cloudflare/workers-types" />
import type { ConnectionInput, ConnectionRow, EntityType } from './schema.js';
import { auditCrossTenantAccess } from './_shared.js';

/**
 * Normalize a/b ordering so a_type <= b_type alphabetically.
 * This ensures the UNIQUE constraint works regardless of call order.
 */
function normalizeConnectionOrder(
	type1: EntityType,
	id1: string,
	type2: EntityType,
	id2: string,
	metadata?: string
): {
	a_type: EntityType;
	a_id: string;
	b_type: EntityType;
	b_id: string;
	metadata?: string;
} {
	if (type1 <= type2) {
		return { a_type: type1, a_id: id1, b_type: type2, b_id: id2, metadata };
	}
	return { a_type: type2, a_id: id2, b_type: type1, b_id: id1, metadata };
}

export async function createConnection(
	db: D1Database,
	input: ConnectionInput,
	userId?: string
): Promise<ConnectionRow> {
	const now = new Date().toISOString();
	const normalized = normalizeConnectionOrder(
		input.a_type,
		input.a_id,
		input.b_type,
		input.b_id,
		input.metadata
	);

	const connection: ConnectionRow = {
		id: input.id || crypto.randomUUID(),
		a_type: normalized.a_type,
		a_id: normalized.a_id,
		b_type: normalized.b_type,
		b_id: normalized.b_id,
		metadata: normalized.metadata,
		created_at: now,
	};

	await db
		.prepare(
			`INSERT INTO connections (id, a_type, a_id, b_type, b_id, metadata, created_at, user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			connection.id,
			connection.a_type,
			connection.a_id,
			connection.b_type,
			connection.b_id,
			connection.metadata || null,
			connection.created_at,
			userId || null
		)
		.run();

	return connection;
}

export async function deleteConnection(
	db: D1Database,
	id: string,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const result = await db
		.prepare(`DELETE FROM connections WHERE id = ? AND user_id = ?`)
		.bind(id, userId)
		.run();
	if (result.meta.changes === 0) {
		await auditCrossTenantAccess(
			db,
			'connections',
			'connection',
			id,
			userId,
			'DELETE'
		);
	}
}

export async function deleteConnectionBetween(
	db: D1Database,
	type1: EntityType,
	id1: string,
	type2: EntityType,
	id2: string,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const normalized = normalizeConnectionOrder(type1, id1, type2, id2);
	await db
		.prepare(
			`DELETE FROM connections WHERE a_type = ? AND a_id = ? AND b_type = ? AND b_id = ? AND user_id = ?`
		)
		.bind(
			normalized.a_type,
			normalized.a_id,
			normalized.b_type,
			normalized.b_id,
			userId
		)
		.run();
}

/**
 * Get all connections involving a specific entity.
 * Searches both sides (a and b) since the entity could be on either side.
 */
export async function getConnections(
	db: D1Database,
	entityType: EntityType,
	entityId: string,
	userId: string
): Promise<ConnectionRow[]> {
	if (!userId) return [];
	const result = await db
		.prepare(
			`SELECT id, a_type, a_id, b_type, b_id, metadata, created_at
			 FROM connections
			 WHERE ((a_type = ?1 AND a_id = ?2) OR (b_type = ?1 AND b_id = ?2)) AND user_id = ?3
			 ORDER BY created_at DESC`
		)
		.bind(entityType, entityId, userId)
		.all<ConnectionRow>();

	return result.results ?? [];
}

/**
 * Get connections between a specific entity and a specific connected type.
 * E.g., "get all books connected to this note".
 */
export async function getConnectionsOfType(
	db: D1Database,
	entityType: EntityType,
	entityId: string,
	connectedType: EntityType,
	userId: string
): Promise<ConnectionRow[]> {
	if (!userId) return [];
	const result = await db
		.prepare(
			`SELECT id, a_type, a_id, b_type, b_id, metadata, created_at
			 FROM connections
			 WHERE ((a_type = ?1 AND a_id = ?2 AND b_type = ?3)
			    OR (b_type = ?1 AND b_id = ?2 AND a_type = ?3)) AND user_id = ?4
			 ORDER BY created_at DESC`
		)
		.bind(entityType, entityId, connectedType, userId)
		.all<ConnectionRow>();

	return result.results ?? [];
}

/**
 * Batched variant of getConnectionsOfType: connections between any of the
 * given entities and a specific connected type. Replaces N per-card
 * /connections calls with one query. Callers group results by entity id
 * (the entity may sit on either side of the connection).
 */
export async function getConnectionsForEntities(
	db: D1Database,
	entityType: EntityType,
	entityIds: string[],
	connectedType: EntityType,
	userId: string
): Promise<ConnectionRow[]> {
	if (!userId || entityIds.length === 0) return [];
	const ids = entityIds.slice(0, 100);
	const placeholders = ids.map(() => '?').join(',');
	const result = await db
		.prepare(
			`SELECT id, a_type, a_id, b_type, b_id, metadata, created_at
			 FROM connections
			 WHERE ((a_type = ? AND a_id IN (${placeholders}) AND b_type = ?)
			    OR (b_type = ? AND b_id IN (${placeholders}) AND a_type = ?)) AND user_id = ?
			 ORDER BY created_at DESC`
		)
		.bind(
			entityType,
			...ids,
			connectedType,
			entityType,
			...ids,
			connectedType,
			userId
		)
		.all<ConnectionRow>();

	return result.results ?? [];
}

/**
 * Replace all connections for an entity: delete existing, insert new ones.
 * Used during edit/versioning flows.
 */
export async function replaceConnections(
	db: D1Database,
	entityType: EntityType,
	entityId: string,
	newConnections: ConnectionInput[],
	userId: string
): Promise<ConnectionRow[]> {
	if (!userId) throw new Error('userId is required');
	await db
		.prepare(
			`DELETE FROM connections
			 WHERE ((a_type = ?1 AND a_id = ?2) OR (b_type = ?1 AND b_id = ?2)) AND user_id = ?3`
		)
		.bind(entityType, entityId, userId)
		.run();

	const created: ConnectionRow[] = [];
	for (const conn of newConnections) {
		created.push(await createConnection(db, conn, userId));
	}
	return created;
}
