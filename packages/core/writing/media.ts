/// <reference types="@cloudflare/workers-types" />
import type { MediaInput, MediaRow } from './schema.js';
import { auditCrossTenantAccess } from './_shared.js';

export async function createMedia(
	db: D1Database,
	input: MediaInput,
	userId?: string
): Promise<MediaRow> {
	const now = new Date().toISOString();
	const media: MediaRow = {
		id: input.id || crypto.randomUUID(),
		title: input.title,
		url: input.url,
		kind: input.kind,
		creator: input.creator,
		note: input.note,
		posted: input.posted ?? 0,
		tags: input.tags,
		source: input.source ?? 'web',
		created_at: now,
		updated_at: now,
	};

	await db
		.prepare(
			`INSERT INTO media (id, title, url, kind, creator, note, posted, tags, source, created_at, updated_at, user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			media.id,
			media.title || null,
			media.url || null,
			media.kind,
			media.creator || null,
			media.note || null,
			media.posted,
			media.tags || null,
			media.source,
			media.created_at,
			media.updated_at,
			userId || null
		)
		.run();

	return media;
}

export async function getMediaList(
	db: D1Database,
	options: {
		limit?: number;
		offset?: number;
		search?: string;
		kind?: string;
	} = {},
	userId: string
): Promise<MediaRow[]> {
	if (!userId) return [];
	const limit = options.limit ?? 50;
	const offset = options.offset ?? 0;

	let query = `SELECT id, title, url, kind, creator, note, posted, tags, source, created_at, updated_at FROM media WHERE 1=1 AND user_id = ?`;
	const params: (string | number)[] = [userId];

	if (options.kind) {
		query += ` AND kind = ?`;
		params.push(options.kind);
	}

	if (options.search) {
		query += ` AND (LOWER(title) LIKE LOWER(?) OR LOWER(creator) LIKE LOWER(?) OR LOWER(note) LIKE LOWER(?))`;
		params.push(
			`%${options.search}%`,
			`%${options.search}%`,
			`%${options.search}%`
		);
	}

	query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
	params.push(limit, offset);

	const result = await db
		.prepare(query)
		.bind(...params)
		.all<MediaRow>();

	return result.results ?? [];
}

export async function getMediaById(
	db: D1Database,
	id: string,
	userId: string
): Promise<MediaRow | null> {
	if (!userId) return null;
	const result = await db
		.prepare(
			`SELECT id, title, url, kind, creator, note, posted, tags, source, created_at, updated_at FROM media WHERE id = ? AND user_id = ?`
		)
		.bind(id, userId)
		.first<MediaRow>();
	if (!result) {
		await auditCrossTenantAccess(db, 'media', 'media', id, userId, 'READ');
		return null;
	}
	return result;
}

export async function updateMedia(
	db: D1Database,
	id: string,
	updates: Partial<MediaInput>,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const existing = await getMediaById(db, id, userId);
	if (!existing) throw new Error(`Media not found: ${id}`);

	const merged = {
		...existing,
		...updates,
		updated_at: new Date().toISOString(),
	};

	await db
		.prepare(
			`UPDATE media SET title = ?, url = ?, kind = ?, creator = ?, note = ?, posted = ?, tags = ?, updated_at = ? WHERE id = ? AND user_id = ?`
		)
		.bind(
			merged.title || null,
			merged.url || null,
			merged.kind,
			merged.creator || null,
			merged.note || null,
			merged.posted ?? 0,
			merged.tags || null,
			merged.updated_at,
			id,
			userId
		)
		.run();
}

export async function deleteMedia(
	db: D1Database,
	id: string,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const result = await db
		.prepare(`DELETE FROM media WHERE id = ? AND user_id = ?`)
		.bind(id, userId)
		.run();
	if (result.meta.changes === 0) {
		await auditCrossTenantAccess(
			db,
			'media',
			'media',
			id,
			userId,
			'DELETE'
		);
	}
}
