/// <reference types="@cloudflare/workers-types" />
import type { EntityType } from './schema.js';
import { createAuditLogEntry } from '../platform/audit.js';

/**
 * Tables whose rows are user-scoped and may be probed for cross-tenant access.
 */
export const AUDITABLE_TABLES = new Set([
	'notes',
	'quotes',
	'essays',
	'essay_images',
	'media',
	'links',
	'sleep',
	'threads',
	'connections',
]);

/**
 * Check if a resource exists for a different user (cross-tenant access attempt).
 * If so, log an audit entry and return true. Otherwise return false.
 * Called when a tenant-scoped query returns no results to distinguish
 * "doesn't exist" from "exists but belongs to another tenant".
 */
export async function auditCrossTenantAccess(
	db: D1Database,
	table: string,
	entityType: string,
	entityId: string,
	userId: string,
	action: 'READ' | 'UPDATE' | 'DELETE'
): Promise<boolean> {
	if (!AUDITABLE_TABLES.has(table)) {
		console.error(
			`auditCrossTenantAccess called with invalid table: ${table}`
		);
		return false;
	}
	try {
		const row = await db
			.prepare(`SELECT user_id FROM ${table} WHERE id = ?`)
			.bind(entityId)
			.first<{ user_id: string | null }>();
		if (row && row.user_id && row.user_id !== userId) {
			await createAuditLogEntry(db, {
				user_id: userId,
				user_tenant_id: userId,
				target_entity_type: entityType,
				target_entity_id: entityId,
				target_tenant_id: row.user_id,
				action,
				outcome: 'BLOCKED',
			});
			return true;
		}
	} catch (err) {
		console.error('Audit log write failed:', err);
	}
	return false;
}

/**
 * When an entity is replaced (edit-as-new-version), migrate connections and
 * thread_items from the old entity to the new one so they aren't severed.
 */
export async function migrateEntityReferences(
	db: D1Database,
	entityType: EntityType,
	oldId: string,
	newId: string,
	userId: string
): Promise<void> {
	if (!userId)
		throw new Error('userId is required for migrateEntityReferences');
	await db
		.prepare(
			`UPDATE connections SET a_id = ? WHERE a_type = ? AND a_id = ? AND user_id = ?`
		)
		.bind(newId, entityType, oldId, userId)
		.run();

	await db
		.prepare(
			`UPDATE connections SET b_id = ? WHERE b_type = ? AND b_id = ? AND user_id = ?`
		)
		.bind(newId, entityType, oldId, userId)
		.run();

	await db
		.prepare(
			`UPDATE thread_items SET entity_id = ?
			 WHERE entity_type = ? AND entity_id = ?
			   AND thread_id IN (SELECT id FROM threads WHERE user_id = ?)`
		)
		.bind(newId, entityType, oldId, userId)
		.run();
}
