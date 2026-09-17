/// <reference types="@cloudflare/workers-types" />
import type { WorkMediaInput, WorkMediaPatch, WorkMediaRow } from './schema.js';

const COLUMNS = `id, work_id, r2_key, kind, caption, sort_order, created_at, updated_at`;

export async function listWorkMedia(
	db: D1Database,
	workId: string
): Promise<WorkMediaRow[]> {
	const result = await db
		.prepare(
			`SELECT ${COLUMNS} FROM work_media WHERE work_id = ?
			   ORDER BY sort_order ASC, created_at ASC`
		)
		.bind(workId)
		.all<WorkMediaRow>();
	return result.results ?? [];
}

export async function createWorkMedia(
	db: D1Database,
	workId: string,
	input: WorkMediaInput,
	userId: string
): Promise<WorkMediaRow> {
	const now = new Date().toISOString();
	const row: WorkMediaRow = {
		id: input.id || crypto.randomUUID(),
		work_id: workId,
		r2_key: input.r2_key,
		kind: input.kind || 'image',
		caption: input.caption,
		sort_order: input.sort_order ?? 0,
		created_at: now,
		updated_at: now,
	};
	await db
		.prepare(
			`INSERT INTO work_media (id, work_id, user_id, r2_key, kind, caption, sort_order, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			row.id,
			row.work_id,
			userId,
			row.r2_key,
			row.kind,
			row.caption ?? null,
			row.sort_order,
			row.created_at,
			row.updated_at
		)
		.run();
	return row;
}

export async function updateWorkMedia(
	db: D1Database,
	mediaId: string,
	patch: WorkMediaPatch
): Promise<void> {
	const sets: string[] = [];
	const params: (string | number | null)[] = [];
	if (patch.caption !== undefined) {
		sets.push('caption = ?');
		params.push(patch.caption ?? null);
	}
	if (patch.sort_order !== undefined) {
		sets.push('sort_order = ?');
		params.push(patch.sort_order);
	}
	if (sets.length === 0) return;
	sets.push('updated_at = ?');
	params.push(new Date().toISOString());
	params.push(mediaId);
	await db
		.prepare(`UPDATE work_media SET ${sets.join(', ')} WHERE id = ?`)
		.bind(...params)
		.run();
}

export async function getWorkMediaById(
	db: D1Database,
	mediaId: string
): Promise<WorkMediaRow | null> {
	const row = await db
		.prepare(`SELECT ${COLUMNS} FROM work_media WHERE id = ?`)
		.bind(mediaId)
		.first<WorkMediaRow>();
	return row || null;
}

export async function deleteWorkMedia(
	db: D1Database,
	mediaId: string
): Promise<void> {
	await db.prepare(`DELETE FROM work_media WHERE id = ?`).bind(mediaId).run();
}
