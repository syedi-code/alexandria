/// <reference types="@cloudflare/workers-types" />
import type {
	EssayInput,
	EssayRow,
	EssayReferenceInput,
	EssayReferenceRow,
	ConnectionInput,
	EntityType,
} from './schema.js';
import { auditCrossTenantAccess, migrateEntityReferences } from './_shared.js';
import { createConnection } from './connections.js';

/**
 * Denormalised essay reference row.
 *
 * The `book_*` names are the Book facade's vocabulary, kept because stylus
 * has always received them; the rows come from `works`.
 *
 * Joined fields depend on entity_type:
 * - 'book'       → book_* fields populated from `works`.
 * - 'book_cover' → book_* fields + book_cover_url, populated from `works`.
 * - 'quote'      → quote_* fields populated from `quotes`; if the quote has
 *                  a book_id, book_* fields populated too.
 * - 'image'      → image_* fields populated from `essay_images`.
 */
export interface EssayReferenceJoined extends EssayReferenceRow {
	book_id?: string;
	book_title?: string;
	book_author?: string;
	book_originally_published?: string;
	book_cover_url?: string;
	quote_text?: string;
	quote_creator?: string;
	quote_work?: string;
	quote_page?: string;
	image_url?: string;
	image_caption?: string;
	image_source_url?: string;
}

/** Denormalized essay with joined references for API responses */
export interface EssayWithReferences extends EssayRow {
	references: EssayReferenceJoined[];
}

async function getReferencesForEssay(
	db: D1Database,
	essayId: string
): Promise<EssayReferenceJoined[]> {
	const result = await db
		.prepare(
			`SELECT er.id, er.essay_id, er.entity_type, er.entity_id, er.page, er.position, er.params,
			        b.id AS book_id,
			        b.title AS book_title,
			        b.creator AS book_author,
			        b.originally_published AS book_originally_published,
			        b.cover_key AS book_cover_url,
			        q.quote AS quote_text,
			        q.creator AS quote_creator,
			        q.work AS quote_work,
			        q.page AS quote_page,
			        qb.id AS quote_book_id,
			        qb.title AS quote_book_title,
			        qb.creator AS quote_book_author,
			        qb.originally_published AS quote_book_originally_published,
			        qb.cover_key AS quote_book_cover_url,
			        ei.path AS image_url,
			        ei.caption AS image_caption,
			        ei.source_url AS image_source_url
			 FROM essay_references er
			 -- Neither join filters deleted_at: essay prose cites work ids
			 -- directly, so an id that once rendered has to keep rendering.
			 LEFT JOIN works b
			        ON er.entity_type IN ('book', 'book_cover') AND b.id = er.entity_id
			 LEFT JOIN quotes q
			        ON er.entity_type = 'quote' AND q.id = er.entity_id
			 LEFT JOIN works qb
			        ON er.entity_type = 'quote' AND qb.id = q.book_id
			 LEFT JOIN essay_images ei
			        ON er.entity_type = 'image' AND ei.id = er.entity_id
			 WHERE er.essay_id = ?
			 ORDER BY er.position ASC`
		)
		.bind(essayId)
		.all();

	type RawRow = Omit<EssayReferenceRow, 'params'> & {
		params?: string | null;
		book_id?: string;
		book_title?: string;
		book_author?: string;
		book_originally_published?: string;
		book_cover_url?: string;
		quote_text?: string;
		quote_creator?: string;
		quote_work?: string;
		quote_page?: string;
		quote_book_id?: string;
		quote_book_title?: string;
		quote_book_author?: string;
		quote_book_originally_published?: string;
		quote_book_cover_url?: string;
		image_url?: string;
		image_caption?: string;
		image_source_url?: string;
	};
	const rows = (result.results ?? []) as RawRow[];

	return rows.map((r) => {
		let parsedParams: Record<string, string | number> | undefined;
		if (r.params) {
			try {
				const v = JSON.parse(r.params);
				if (v && typeof v === 'object' && !Array.isArray(v)) {
					parsedParams = v as Record<string, string | number>;
				}
			} catch {
				// malformed JSON in DB — drop silently
			}
		}
		const out: EssayReferenceJoined = {
			id: r.id,
			essay_id: r.essay_id,
			entity_type: r.entity_type,
			entity_id: r.entity_id,
			page: r.page ?? undefined,
			position: r.position ?? 0,
			params: parsedParams,
		};
		if (r.entity_type === 'book' || r.entity_type === 'book_cover') {
			out.book_id = r.book_id ?? r.entity_id;
			out.book_title = r.book_title;
			out.book_author = r.book_author;
			out.book_originally_published = r.book_originally_published;
			out.book_cover_url = r.book_cover_url;
		} else if (r.entity_type === 'quote') {
			out.quote_text = r.quote_text;
			out.quote_creator = r.quote_creator;
			out.quote_work = r.quote_work;
			out.quote_page = r.quote_page;
			if (r.quote_book_id) {
				out.book_id = r.quote_book_id;
				out.book_title = r.quote_book_title;
				out.book_author = r.quote_book_author;
				out.book_originally_published =
					r.quote_book_originally_published;
				out.book_cover_url = r.quote_book_cover_url;
			}
		} else if (r.entity_type === 'image') {
			out.image_url = r.image_url;
			out.image_caption = r.image_caption;
			out.image_source_url = r.image_source_url;
		}
		return out;
	});
}

async function insertEssayReferences(
	db: D1Database,
	essayId: string,
	references: EssayReferenceInput[]
): Promise<void> {
	for (let i = 0; i < references.length; i++) {
		const ref = references[i];
		const paramsJson =
			ref.params && Object.keys(ref.params).length > 0
				? JSON.stringify(ref.params)
				: null;
		await db
			.prepare(
				`INSERT INTO essay_references (id, essay_id, entity_type, entity_id, page, position, params)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				crypto.randomUUID(),
				essayId,
				ref.entity_type,
				ref.entity_id,
				ref.page || null,
				ref.position ?? i,
				paramsJson
			)
			.run();
	}
}

export async function createEssay(
	db: D1Database,
	input: EssayInput,
	references: EssayReferenceInput[],
	connections?: ConnectionInput[],
	userId?: string
): Promise<EssayWithReferences> {
	const now = new Date().toISOString();
	const essay: EssayRow = {
		id: input.id || crypto.randomUUID(),
		content: input.content,
		posted: input.posted ?? 0,
		tags: input.tags,
		replaces: input.replaces,
		source: input.source ?? 'web',
		created_at: now,
		updated_at: now,
	};

	await db
		.prepare(
			`INSERT INTO essays (id, content, posted, tags, replaces, source, created_at, updated_at, user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			essay.id,
			essay.content,
			essay.posted,
			essay.tags || null,
			essay.replaces || null,
			essay.source,
			essay.created_at,
			essay.updated_at,
			userId || null
		)
		.run();

	await insertEssayReferences(db, essay.id, references);

	if (essay.replaces && userId) {
		await migrateEntityReferences(
			db,
			'essay' as EntityType,
			essay.replaces,
			essay.id,
			userId
		);
	}

	if (connections && connections.length > 0) {
		for (const conn of connections) {
			await createConnection(db, conn, userId);
		}
	}

	const refs = await getReferencesForEssay(db, essay.id);
	return { ...essay, references: refs };
}

export async function getEssays(
	db: D1Database,
	options: {
		limit?: number;
		offset?: number;
		search?: string;
		posted?: number;
		book_id?: string;
	} = {},
	userId: string
): Promise<{ data: EssayWithReferences[]; hasMore: boolean }> {
	if (!userId) return { data: [], hasMore: false };
	const limit = options.limit ?? 50;
	const offset = options.offset ?? 0;

	let query = `SELECT id, content, posted, tags, replaces, source, created_at, updated_at FROM essays WHERE user_id = ? AND id NOT IN (SELECT replaces FROM essays WHERE replaces IS NOT NULL AND user_id = ?)`;
	const params: (string | number)[] = [userId, userId];

	if (options.posted != null) {
		query += ` AND posted = ?`;
		params.push(options.posted);
	}

	if (options.book_id) {
		query += ` AND id IN (
			SELECT essay_id FROM essay_references
			WHERE entity_type IN ('book', 'book_cover') AND entity_id = ?
			UNION
			SELECT er.essay_id FROM essay_references er
			JOIN quotes q ON q.id = er.entity_id
			WHERE er.entity_type = 'quote' AND q.book_id = ?
		)`;
		params.push(options.book_id, options.book_id);
	}

	if (options.search) {
		query += ` AND LOWER(content) LIKE LOWER(?)`;
		params.push(`%${options.search}%`);
	}

	query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
	params.push(limit + 1, offset);

	const result = await db
		.prepare(query)
		.bind(...params)
		.all<EssayRow>();

	const rows = result.results ?? [];
	const hasMore = rows.length > limit;
	const essays = hasMore ? rows.slice(0, limit) : rows;

	const essaysWithRefs: EssayWithReferences[] = [];
	for (const essay of essays) {
		const refs = await getReferencesForEssay(db, essay.id);
		essaysWithRefs.push({ ...essay, references: refs });
	}

	return { data: essaysWithRefs, hasMore };
}

export async function getEssayById(
	db: D1Database,
	id: string,
	userId: string
): Promise<EssayWithReferences | null> {
	if (!userId) return null;
	const result = await db
		.prepare(
			`SELECT id, content, posted, tags, replaces, source, created_at, updated_at FROM essays WHERE id = ? AND user_id = ?`
		)
		.bind(id, userId)
		.first<EssayRow>();
	if (!result) {
		await auditCrossTenantAccess(db, 'essays', 'essay', id, userId, 'READ');
		return null;
	}
	const refs = await getReferencesForEssay(db, result.id);
	return { ...result, references: refs };
}

export async function updateEssay(
	db: D1Database,
	id: string,
	updates: Partial<EssayInput>,
	references?: EssayReferenceInput[],
	userId?: string
): Promise<EssayWithReferences> {
	if (!userId) throw new Error('userId is required');
	const existing = await getEssayById(db, id, userId);
	if (!existing) throw new Error(`Essay not found: ${id}`);

	const merged = {
		...existing,
		...updates,
		updated_at: new Date().toISOString(),
	};

	await db
		.prepare(
			`UPDATE essays SET content = ?, posted = ?, tags = ?, replaces = ?, updated_at = ? WHERE id = ? AND user_id = ?`
		)
		.bind(
			merged.content,
			merged.posted ?? 0,
			merged.tags || null,
			merged.replaces || null,
			merged.updated_at,
			id,
			userId
		)
		.run();

	if (references) {
		await db
			.prepare(`DELETE FROM essay_references WHERE essay_id = ?`)
			.bind(id)
			.run();
		await insertEssayReferences(db, id, references);
	}

	const refs = await getReferencesForEssay(db, id);
	return {
		id,
		content: merged.content,
		posted: merged.posted ?? 0,
		tags: merged.tags,
		replaces: merged.replaces,
		source: merged.source ?? 'web',
		created_at: existing.created_at,
		updated_at: merged.updated_at,
		references: refs,
	};
}

export async function deleteEssay(
	db: D1Database,
	id: string,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const result = await db
		.prepare(`DELETE FROM essays WHERE id = ? AND user_id = ?`)
		.bind(id, userId)
		.run();
	if (result.meta.changes === 0) {
		await auditCrossTenantAccess(
			db,
			'essays',
			'essay',
			id,
			userId,
			'DELETE'
		);
	}
}

export async function getEssayVersions(
	db: D1Database,
	id: string,
	userId: string
): Promise<EssayWithReferences[]> {
	if (!userId) return [];

	const versions: EssayWithReferences[] = [];
	let currentId: string | null = id;
	const visited = new Set<string>();

	let rootId = id;
	while (true) {
		const row = await db
			.prepare(`SELECT replaces FROM essays WHERE id = ? AND user_id = ?`)
			.bind(rootId, userId)
			.first<{ replaces: string | null }>();
		if (!row || !row.replaces) break;
		rootId = row.replaces;
		if (visited.has(rootId)) break;
		visited.add(rootId);
	}

	visited.clear();
	currentId = rootId;
	while (currentId) {
		if (visited.has(currentId)) break;
		visited.add(currentId);

		const essay = await getEssayById(db, currentId, userId);
		if (!essay) break;
		versions.push(essay);

		const next = await db
			.prepare(`SELECT id FROM essays WHERE replaces = ? AND user_id = ?`)
			.bind(currentId, userId)
			.first<{ id: string }>();
		currentId = next ? next.id : null;
	}

	return versions.reverse();
}
