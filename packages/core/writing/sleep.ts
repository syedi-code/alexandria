/// <reference types="@cloudflare/workers-types" />
import type { SleepInput, SleepRow } from './schema.js';
import { auditCrossTenantAccess } from './_shared.js';

export async function createSleep(
	db: D1Database,
	input: SleepInput,
	userId?: string
): Promise<SleepRow> {
	const now = new Date().toISOString();
	const sleep: SleepRow = {
		id: input.id || crypto.randomUUID(),
		hours: input.hours,
		quality: input.quality,
		bed_time: input.bed_time,
		wake_time: input.wake_time,
		note: input.note,
		tags: input.tags,
		source: input.source ?? 'web',
		created_at: now,
	};

	await db
		.prepare(
			`INSERT INTO sleep (id, hours, quality, bed_time, wake_time, note, tags, source, created_at, user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			sleep.id,
			sleep.hours,
			sleep.quality ?? null,
			sleep.bed_time || null,
			sleep.wake_time || null,
			sleep.note || null,
			sleep.tags || null,
			sleep.source,
			sleep.created_at,
			userId || null
		)
		.run();

	return sleep;
}

export async function getSleepEntries(
	db: D1Database,
	options: { limit?: number; offset?: number } = {},
	userId: string
): Promise<SleepRow[]> {
	if (!userId) return [];
	const limit = options.limit ?? 50;
	const offset = options.offset ?? 0;

	const result = await db
		.prepare(
			`SELECT id, hours, quality, bed_time, wake_time, note, tags, source, created_at FROM sleep WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
		)
		.bind(userId, limit, offset)
		.all<SleepRow>();

	return result.results ?? [];
}

export async function getSleepById(
	db: D1Database,
	id: string,
	userId: string
): Promise<SleepRow | null> {
	if (!userId) return null;
	const result = await db
		.prepare(
			`SELECT id, hours, quality, bed_time, wake_time, note, tags, source, created_at FROM sleep WHERE id = ? AND user_id = ?`
		)
		.bind(id, userId)
		.first<SleepRow>();
	if (!result) {
		await auditCrossTenantAccess(db, 'sleep', 'sleep', id, userId, 'READ');
		return null;
	}
	return result;
}

export async function deleteSleep(
	db: D1Database,
	id: string,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const result = await db
		.prepare(`DELETE FROM sleep WHERE id = ? AND user_id = ?`)
		.bind(id, userId)
		.run();
	if (result.meta.changes === 0) {
		await auditCrossTenantAccess(
			db,
			'sleep',
			'sleep',
			id,
			userId,
			'DELETE'
		);
	}
}
