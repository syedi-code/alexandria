/// <reference types="@cloudflare/workers-types" />
import type {
	ThreadInput,
	ThreadRow,
	ThreadItemRow,
	ReorderItem,
} from './schema.js';
import { auditCrossTenantAccess } from './_shared.js';

export async function createThread(
	db: D1Database,
	input: ThreadInput,
	userId?: string
): Promise<ThreadRow> {
	const now = new Date().toISOString();
	const thread: ThreadRow = {
		id: input.id || crypto.randomUUID(),
		name: input.name,
		description: input.description,
		created_at: now,
		updated_at: now,
	};

	await db
		.prepare(
			`INSERT INTO threads (id, name, description, created_at, updated_at, user_id)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.bind(
			thread.id,
			thread.name,
			thread.description || null,
			thread.created_at,
			thread.updated_at,
			userId || null
		)
		.run();

	return thread;
}

export async function updateThread(
	db: D1Database,
	id: string,
	updates: Partial<Pick<ThreadRow, 'name' | 'description'>>,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const fields: string[] = [];
	const values: (string | null)[] = [];

	if (updates.name !== undefined) {
		fields.push('name = ?');
		values.push(updates.name);
	}
	if (updates.description !== undefined) {
		fields.push('description = ?');
		values.push(updates.description || null);
	}

	if (fields.length === 0) return;

	fields.push('updated_at = ?');
	values.push(new Date().toISOString());
	values.push(id);
	values.push(userId);

	await db
		.prepare(
			`UPDATE threads SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`
		)
		.bind(...values)
		.run();
}

export async function deleteThread(
	db: D1Database,
	id: string,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const result = await db
		.prepare(`DELETE FROM threads WHERE id = ? AND user_id = ?`)
		.bind(id, userId)
		.run();
	if (result.meta.changes === 0) {
		await auditCrossTenantAccess(
			db,
			'threads',
			'thread',
			id,
			userId,
			'DELETE'
		);
	}
}

export async function getThreads(
	db: D1Database,
	options: { limit?: number; offset?: number; search?: string } = {},
	userId: string
): Promise<(ThreadRow & { item_count: number; item_types: string[] })[]> {
	if (!userId) return [];
	const limit = options.limit ?? 100;
	const offset = options.offset ?? 0;

	let query = `SELECT t.id, t.name, t.description, t.created_at, t.updated_at,
			COUNT(ti.id) as item_count,
			(SELECT GROUP_CONCAT(ti2.entity_type, ',') FROM (
				SELECT entity_type FROM thread_items WHERE thread_id = t.id ORDER BY position ASC
			) ti2) as item_types_csv
		 FROM threads t
		 LEFT JOIN thread_items ti ON ti.thread_id = t.id
		 WHERE 1=1 AND t.user_id = ?`;
	const params: (string | number)[] = [userId];

	if (options.search) {
		query += ` AND (LOWER(t.name) LIKE LOWER(?) OR LOWER(t.description) LIKE LOWER(?))`;
		params.push(`%${options.search}%`, `%${options.search}%`);
	}

	query += ` GROUP BY t.id ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`;
	params.push(limit, offset);

	const result = await db
		.prepare(query)
		.bind(...params)
		.all<
			ThreadRow & { item_count: number; item_types_csv: string | null }
		>();

	return (result.results ?? []).map((row) => {
		const { item_types_csv, ...rest } = row;
		return {
			...rest,
			item_types: item_types_csv ? item_types_csv.split(',') : [],
		};
	});
}

export async function getThreadById(
	db: D1Database,
	id: string,
	userId: string
): Promise<ThreadRow | null> {
	if (!userId) return null;
	const result = await db
		.prepare(
			`SELECT id, name, description, created_at, updated_at FROM threads WHERE id = ? AND user_id = ?`
		)
		.bind(id, userId)
		.first<ThreadRow>();
	if (!result) {
		await auditCrossTenantAccess(
			db,
			'threads',
			'thread',
			id,
			userId,
			'READ'
		);
		return null;
	}
	return result;
}

export async function getThreadItems(
	db: D1Database,
	threadId: string,
	userId: string
): Promise<ThreadItemRow[]> {
	if (!userId) return [];
	const result = await db
		.prepare(
			`SELECT ti.id, ti.thread_id, ti.entity_type, ti.entity_id, ti.position, ti.added_at
			 FROM thread_items ti
			 INNER JOIN threads t ON t.id = ti.thread_id
			 WHERE ti.thread_id = ? AND t.user_id = ?
			 ORDER BY ti.position ASC`
		)
		.bind(threadId, userId)
		.all<ThreadItemRow>();

	return result.results ?? [];
}

export async function addThreadItem(
	db: D1Database,
	threadId: string,
	entityType: string,
	entityId: string,
	userId: string
): Promise<ThreadItemRow> {
	if (!userId) throw new Error('userId is required');
	const thread = await getThreadById(db, threadId, userId);
	if (!thread) throw new Error(`Thread not found: ${threadId}`);

	const now = new Date().toISOString();

	const maxResult = await db
		.prepare(
			`SELECT COALESCE(MAX(position), -1) as max_pos FROM thread_items WHERE thread_id = ?`
		)
		.bind(threadId)
		.first<{ max_pos: number }>();

	const position = (maxResult?.max_pos ?? -1) + 1;

	const item: ThreadItemRow = {
		id: crypto.randomUUID(),
		thread_id: threadId,
		entity_type: entityType,
		entity_id: entityId,
		position,
		added_at: now,
	};

	await db
		.prepare(
			`INSERT INTO thread_items (id, thread_id, entity_type, entity_id, position, added_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.bind(
			item.id,
			item.thread_id,
			item.entity_type,
			item.entity_id,
			item.position,
			item.added_at
		)
		.run();

	await db
		.prepare(
			`UPDATE threads SET updated_at = ? WHERE id = ? AND user_id = ?`
		)
		.bind(now, threadId, userId)
		.run();

	return item;
}

export async function removeThreadItem(
	db: D1Database,
	threadId: string,
	entityType: string,
	entityId: string,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const thread = await getThreadById(db, threadId, userId);
	if (!thread) throw new Error(`Thread not found: ${threadId}`);

	await db
		.prepare(
			`DELETE FROM thread_items WHERE thread_id = ? AND entity_type = ? AND entity_id = ?`
		)
		.bind(threadId, entityType, entityId)
		.run();

	const remaining = await db
		.prepare(
			`SELECT id FROM thread_items WHERE thread_id = ? ORDER BY position ASC`
		)
		.bind(threadId)
		.all<{ id: string }>();

	const items = remaining.results ?? [];
	for (let i = 0; i < items.length; i++) {
		await db
			.prepare(`UPDATE thread_items SET position = ? WHERE id = ?`)
			.bind(i, items[i].id)
			.run();
	}

	await db
		.prepare(
			`UPDATE threads SET updated_at = ? WHERE id = ? AND user_id = ?`
		)
		.bind(new Date().toISOString(), threadId, userId)
		.run();
}

export async function removeThreadItemById(
	db: D1Database,
	threadId: string,
	itemId: string,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const thread = await getThreadById(db, threadId, userId);
	if (!thread) throw new Error(`Thread not found: ${threadId}`);

	await db
		.prepare(`DELETE FROM thread_items WHERE id = ? AND thread_id = ?`)
		.bind(itemId, threadId)
		.run();

	const remaining = await db
		.prepare(
			`SELECT id FROM thread_items WHERE thread_id = ? ORDER BY position ASC`
		)
		.bind(threadId)
		.all<{ id: string }>();

	const items = remaining.results ?? [];
	for (let i = 0; i < items.length; i++) {
		await db
			.prepare(`UPDATE thread_items SET position = ? WHERE id = ?`)
			.bind(i, items[i].id)
			.run();
	}

	await db
		.prepare(
			`UPDATE threads SET updated_at = ? WHERE id = ? AND user_id = ?`
		)
		.bind(new Date().toISOString(), threadId, userId)
		.run();
}

export async function reorderThreadItems(
	db: D1Database,
	threadId: string,
	items: ReorderItem[],
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const thread = await getThreadById(db, threadId, userId);
	if (!thread) throw new Error(`Thread not found: ${threadId}`);

	for (const item of items) {
		await db
			.prepare(
				`UPDATE thread_items SET position = ? WHERE thread_id = ? AND entity_type = ? AND entity_id = ?`
			)
			.bind(item.position, threadId, item.entity_type, item.entity_id)
			.run();
	}

	await db
		.prepare(
			`UPDATE threads SET updated_at = ? WHERE id = ? AND user_id = ?`
		)
		.bind(new Date().toISOString(), threadId, userId)
		.run();
}

export async function getThreadsForEntity(
	db: D1Database,
	entityType: string,
	entityId: string,
	userId: string
): Promise<(ThreadRow & { item_count: number })[]> {
	if (!userId) return [];
	const result = await db
		.prepare(
			`SELECT t.id, t.name, t.description, t.created_at, t.updated_at,
				(SELECT COUNT(*) FROM thread_items ti2 WHERE ti2.thread_id = t.id) as item_count
			 FROM threads t
			 INNER JOIN thread_items ti ON ti.thread_id = t.id
			 WHERE ti.entity_type = ? AND ti.entity_id = ? AND t.user_id = ?
			 ORDER BY t.updated_at DESC`
		)
		.bind(entityType, entityId, userId)
		.all<ThreadRow & { item_count: number }>();

	return result.results ?? [];
}

/** Max entity ids accepted by the batched reverse lookups. */
export const MAX_BATCH_ENTITY_IDS = 100;

/**
 * Batched reverse lookup: threads containing any of the given entities.
 * Returns one row per (thread, entity) pair so the caller can group by
 * entity_id. Replaces N per-card /threads/for-entity calls with one query.
 */
export async function getThreadsForEntities(
	db: D1Database,
	entityType: string,
	entityIds: string[],
	userId: string
): Promise<(ThreadRow & { entity_id: string })[]> {
	if (!userId || entityIds.length === 0) return [];
	const ids = entityIds.slice(0, MAX_BATCH_ENTITY_IDS);
	const placeholders = ids.map(() => '?').join(',');
	const result = await db
		.prepare(
			`SELECT t.id, t.name, t.description, t.created_at, t.updated_at,
				ti.entity_id as entity_id
			 FROM threads t
			 INNER JOIN thread_items ti ON ti.thread_id = t.id
			 WHERE ti.entity_type = ? AND ti.entity_id IN (${placeholders}) AND t.user_id = ?
			 ORDER BY t.updated_at DESC`
		)
		.bind(entityType, ...ids, userId)
		.all<ThreadRow & { entity_id: string }>();

	return result.results ?? [];
}
