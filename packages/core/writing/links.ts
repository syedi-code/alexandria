/// <reference types="@cloudflare/workers-types" />
import type { LinkInput, LinkRow } from './schema.js';
import { auditCrossTenantAccess } from './_shared.js';

export async function createLink(
	db: D1Database,
	input: LinkInput,
	userId?: string
): Promise<LinkRow> {
	const now = new Date().toISOString();
	const link: LinkRow = {
		id: input.id || crypto.randomUUID(),
		title: input.title,
		url: input.url,
		site: input.site,
		og_title: input.og_title,
		note: input.note,
		posted: input.posted ?? 0,
		tags: input.tags,
		source: input.source ?? 'web',
		created_at: now,
		updated_at: now,
	};

	await db
		.prepare(
			`INSERT INTO links (id, title, url, site, og_title, note, posted, tags, source, created_at, updated_at, user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			link.id,
			link.title || null,
			link.url,
			link.site || null,
			link.og_title || null,
			link.note || null,
			link.posted,
			link.tags || null,
			link.source,
			link.created_at,
			link.updated_at,
			userId || null
		)
		.run();

	return link;
}

export async function getLinks(
	db: D1Database,
	options: {
		limit?: number;
		offset?: number;
		search?: string;
		posted?: number;
	} = {},
	userId: string
): Promise<LinkRow[]> {
	if (!userId) return [];
	const limit = options.limit ?? 50;
	const offset = options.offset ?? 0;

	let query = `SELECT id, title, url, site, og_title, note, posted, tags, source, created_at, updated_at FROM links WHERE 1=1 AND user_id = ?`;
	const params: (string | number)[] = [userId];

	if (options.posted != null) {
		query += ` AND posted = ?`;
		params.push(options.posted);
	}

	if (options.search) {
		query += ` AND (LOWER(title) LIKE LOWER(?) OR LOWER(url) LIKE LOWER(?) OR LOWER(note) LIKE LOWER(?))`;
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
		.all<LinkRow>();

	return result.results ?? [];
}

export async function getLinkById(
	db: D1Database,
	id: string,
	userId: string
): Promise<LinkRow | null> {
	if (!userId) return null;
	const result = await db
		.prepare(
			`SELECT id, title, url, site, og_title, note, posted, tags, source, created_at, updated_at FROM links WHERE id = ? AND user_id = ?`
		)
		.bind(id, userId)
		.first<LinkRow>();
	if (!result) {
		await auditCrossTenantAccess(db, 'links', 'link', id, userId, 'READ');
		return null;
	}
	return result;
}

export async function updateLink(
	db: D1Database,
	id: string,
	updates: Partial<LinkInput>,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const existing = await getLinkById(db, id, userId);
	if (!existing) throw new Error(`Link not found: ${id}`);

	const merged = {
		...existing,
		...updates,
		updated_at: new Date().toISOString(),
	};

	await db
		.prepare(
			`UPDATE links SET title = ?, url = ?, site = ?, og_title = ?, note = ?, posted = ?, tags = ?, updated_at = ? WHERE id = ? AND user_id = ?`
		)
		.bind(
			merged.title || null,
			merged.url,
			merged.site || null,
			merged.og_title || null,
			merged.note || null,
			merged.posted ?? 0,
			merged.tags || null,
			merged.updated_at,
			id,
			userId
		)
		.run();
}

export async function deleteLink(
	db: D1Database,
	id: string,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const result = await db
		.prepare(`DELETE FROM links WHERE id = ? AND user_id = ?`)
		.bind(id, userId)
		.run();
	if (result.meta.changes === 0) {
		await auditCrossTenantAccess(db, 'links', 'link', id, userId, 'DELETE');
	}
}
