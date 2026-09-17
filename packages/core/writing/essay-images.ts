/// <reference types="@cloudflare/workers-types" />
import type {
	EssayImageInput,
	EssayImagePatch,
	EssayImageRow,
} from './schema.js';
import { auditCrossTenantAccess } from './_shared.js';

export async function createEssayImage(
	db: D1Database,
	input: EssayImageInput,
	userId: string
): Promise<EssayImageRow> {
	const now = new Date().toISOString();
	const row: EssayImageRow = {
		id: input.id || crypto.randomUUID(),
		user_id: userId,
		path: input.path,
		mime_type: input.mime_type,
		caption: input.caption,
		source_url: input.source_url,
		created_at: now,
		updated_at: now,
	};
	await db
		.prepare(
			`INSERT INTO essay_images (id, user_id, path, mime_type, caption, source_url, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			row.id,
			row.user_id,
			row.path,
			row.mime_type ?? null,
			row.caption ?? null,
			row.source_url ?? null,
			row.created_at,
			row.updated_at
		)
		.run();
	return row;
}

export async function getEssayImageById(
	db: D1Database,
	id: string,
	userId: string
): Promise<EssayImageRow | null> {
	const row = await db
		.prepare(
			`SELECT id, user_id, path, mime_type, caption, source_url, created_at, updated_at
			   FROM essay_images WHERE id = ? AND user_id = ?`
		)
		.bind(id, userId)
		.first<EssayImageRow>();
	if (!row) {
		await auditCrossTenantAccess(
			db,
			'essay_images',
			'essay' /* nearest entity_type for audit */,
			id,
			userId,
			'READ'
		);
		return null;
	}
	return row;
}

export async function updateEssayImage(
	db: D1Database,
	id: string,
	patch: EssayImagePatch,
	userId: string
): Promise<void> {
	const sets: string[] = [];
	const params: (string | null)[] = [];
	if (patch.caption !== undefined) {
		sets.push('caption = ?');
		params.push(patch.caption ?? null);
	}
	if (patch.source_url !== undefined) {
		sets.push('source_url = ?');
		params.push(patch.source_url ?? null);
	}
	if (sets.length === 0) return;
	sets.push('updated_at = ?');
	params.push(new Date().toISOString());
	params.push(id);
	params.push(userId);
	const result = await db
		.prepare(
			`UPDATE essay_images SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
		)
		.bind(...params)
		.run();
	if (result.meta.changes === 0) {
		await auditCrossTenantAccess(
			db,
			'essay_images',
			'essay',
			id,
			userId,
			'UPDATE'
		);
	}
}

export async function deleteEssayImage(
	db: D1Database,
	id: string,
	userId: string
): Promise<void> {
	const result = await db
		.prepare(`DELETE FROM essay_images WHERE id = ? AND user_id = ?`)
		.bind(id, userId)
		.run();
	if (result.meta.changes === 0) {
		await auditCrossTenantAccess(
			db,
			'essay_images',
			'essay',
			id,
			userId,
			'DELETE'
		);
	}
}
