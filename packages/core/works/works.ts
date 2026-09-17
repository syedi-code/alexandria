/// <reference types="@cloudflare/workers-types" />
import type { Work, WorkInput, WorkPatch } from './schema.js';

const COLUMNS = `id, kind, title, creator, creator_id, originally_published,
	isbn, description, cover_key, primary_document_id, deleted_at,
	created_at, updated_at`;

export async function createWork(
	db: D1Database,
	input: WorkInput,
	userId?: string
): Promise<Work> {
	const now = new Date().toISOString();
	const work: Work = {
		id: input.id || crypto.randomUUID(),
		kind: input.kind ?? 'book',
		title: input.title,
		creator: input.creator,
		creator_id: input.creator_id,
		originally_published: input.originally_published,
		isbn: input.isbn,
		description: input.description,
		cover_key: input.cover_key,
		primary_document_id: input.primary_document_id,
		deleted_at: null,
		created_at: now,
		updated_at: now,
	};

	await db
		.prepare(
			`INSERT INTO works (id, kind, title, creator, creator_id, originally_published,
			                    isbn, description, cover_key, primary_document_id,
			                    created_at, updated_at, user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			work.id,
			work.kind,
			work.title,
			work.creator,
			work.creator_id || null,
			work.originally_published || null,
			work.isbn || null,
			work.description || null,
			work.cover_key || null,
			work.primary_document_id || null,
			work.created_at,
			work.updated_at,
			userId || null
		)
		.run();

	return work;
}

export interface WorkListOptions {
	kind?: string;
	search?: string;
	limit?: number;
	offset?: number;
	includeDeleted?: boolean;
}

export async function listWorks(
	db: D1Database,
	options: WorkListOptions = {}
): Promise<Work[]> {
	const where: string[] = ['1=1'];
	const params: (string | number)[] = [];

	if (!options.includeDeleted) where.push('deleted_at IS NULL');
	if (options.kind) {
		where.push('kind = ?');
		params.push(options.kind);
	}
	if (options.search) {
		where.push(
			'(LOWER(title) LIKE LOWER(?) OR LOWER(creator) LIKE LOWER(?))'
		);
		params.push(`%${options.search}%`, `%${options.search}%`);
	}
	params.push(options.limit ?? 100, options.offset ?? 0);

	const result = await db
		.prepare(
			`SELECT ${COLUMNS} FROM works
			  WHERE ${where.join(' AND ')}
			  ORDER BY created_at DESC LIMIT ? OFFSET ?`
		)
		.bind(...params)
		.all<Work>();

	return result.results ?? [];
}

/**
 * Resolves soft-deleted works too. A work id is embedded in essay prose as a
 * [[book:UUID]] token, so an essay written years ago has to keep rendering
 * after the work is removed from the catalogue.
 */
export async function getWorkById(
	db: D1Database,
	id: string
): Promise<Work | null> {
	const result = await db
		.prepare(`SELECT ${COLUMNS} FROM works WHERE id = ?`)
		.bind(id)
		.first<Work>();

	return result || null;
}

export async function updateWork(
	db: D1Database,
	id: string,
	updates: WorkPatch
): Promise<void> {
	const existing = await getWorkById(db, id);
	if (!existing) throw new Error(`Work not found: ${id}`);

	// A patch means "the fields that are present". Spreading would let an
	// explicit `undefined` clobber a NOT NULL column; `null` still clears.
	const merged = { ...existing, updated_at: new Date().toISOString() };
	for (const [key, value] of Object.entries(updates)) {
		if (value !== undefined) {
			(merged as Record<string, unknown>)[key] = value;
		}
	}

	await db
		.prepare(
			`UPDATE works SET kind = ?, title = ?, creator = ?, creator_id = ?,
			                  originally_published = ?, isbn = ?, description = ?,
			                  cover_key = ?, primary_document_id = ?, updated_at = ?
			  WHERE id = ?`
		)
		.bind(
			merged.kind,
			merged.title,
			merged.creator,
			merged.creator_id || null,
			merged.originally_published || null,
			merged.isbn || null,
			merged.description || null,
			merged.cover_key || null,
			merged.primary_document_id || null,
			merged.updated_at,
			id
		)
		.run();
}

/**
 * Soft delete (plan D21). Hard-deleting would break the FK from notes and
 * quotes, and would silently break any essay that cites the work.
 */
export async function deleteWork(db: D1Database, id: string): Promise<void> {
	const now = new Date().toISOString();
	await db
		.prepare(
			`UPDATE works SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`
		)
		.bind(now, now, id)
		.run();
}

export async function restoreWork(db: D1Database, id: string): Promise<void> {
	await db
		.prepare(
			`UPDATE works SET deleted_at = NULL, updated_at = ? WHERE id = ?`
		)
		.bind(new Date().toISOString(), id)
		.run();
}
