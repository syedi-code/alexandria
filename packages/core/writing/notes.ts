/// <reference types="@cloudflare/workers-types" />
import type {
	NoteInput,
	NoteRow,
	NoteView,
	ConnectionInput,
	EntityType,
} from './schema.js';
import { auditCrossTenantAccess, migrateEntityReferences } from './_shared.js';
import { createConnection } from './connections.js';

export async function createNote(
	db: D1Database,
	input: NoteInput,
	connections?: ConnectionInput[],
	userId?: string
): Promise<NoteView> {
	const now = new Date().toISOString();
	let inheritedLastSurfacedAt: string | null | undefined;
	if (input.replaces && userId) {
		const replaced = await db
			.prepare(
				`SELECT last_surfaced_at FROM notes WHERE id = ? AND user_id = ?`
			)
			.bind(input.replaces, userId)
			.first<{ last_surfaced_at: string | null }>();
		if (!replaced) throw new Error(`Note not found: ${input.replaces}`);
		inheritedLastSurfacedAt = replaced.last_surfaced_at;
	}
	const note: NoteRow = {
		id: input.id || crypto.randomUUID(),
		content: input.content,
		creator: input.creator,
		work: input.work,
		kind: input.kind,
		book_id: input.book_id,
		page: input.page,
		posted: input.posted ?? 0,
		tags: input.tags,
		replaces: input.replaces,
		source: input.source ?? 'web',
		created_at: now,
		updated_at: now,
		last_surfaced_at: inheritedLastSurfacedAt,
	};

	await db
		.prepare(
			`INSERT INTO notes (id, content, creator, work, kind, book_id, page, posted, tags, replaces, source, created_at, updated_at, last_surfaced_at, user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			note.id,
			note.content,
			note.creator || null,
			note.work || null,
			note.kind || null,
			note.book_id || null,
			note.page || null,
			note.posted,
			note.tags || null,
			note.replaces || null,
			note.source,
			note.created_at,
			note.updated_at,
			note.last_surfaced_at ?? null,
			userId || null
		)
		.run();

	if (note.replaces && userId) {
		await migrateEntityReferences(
			db,
			'note' as EntityType,
			note.replaces,
			note.id,
			userId
		);
		await db
			.prepare(
				`DELETE FROM connections
				 WHERE (a_type = 'author' AND b_type = 'note' AND b_id = ?)
				    OR (a_type = 'book' AND b_type = 'note' AND b_id = ?)`
			)
			.bind(note.id, note.id)
			.run();
	}

	if (connections && connections.length > 0) {
		for (const conn of connections) {
			await createConnection(db, conn, userId);
		}
	} else if (note.book_id) {
		const metadata = note.page
			? JSON.stringify({ page: note.page })
			: undefined;
		await createConnection(
			db,
			{
				a_type: 'book' as EntityType,
				a_id: note.book_id,
				b_type: 'note' as EntityType,
				b_id: note.id,
				metadata,
			},
			userId
		);
	}

	if (!userId) {
		return { ...note, version: 1, originalCreatedAt: note.created_at };
	}
	return (await getNoteById(db, note.id, userId))!;
}

/**
 * Add logical-note metadata to physical head rows using tenant-scoped
 * ancestors supplied by the caller. Missing ancestors terminate the chain.
 */
export function projectNoteLineage(
	heads: NoteRow[],
	ancestors: NoteRow[]
): NoteView[] {
	const byId = new Map<string, NoteRow>();
	for (const note of [...ancestors, ...heads]) byId.set(note.id, note);

	return heads.map((head) => {
		let current = head;
		let version = 1;
		const visited = new Set([head.id]);
		while (current.replaces) {
			const previous = byId.get(current.replaces);
			if (!previous || visited.has(previous.id)) break;
			visited.add(previous.id);
			current = previous;
			version++;
		}
		return {
			...head,
			version,
			originalCreatedAt: current.created_at,
		};
	});
}

async function enrichNoteLineage(
	db: D1Database,
	heads: NoteRow[],
	userId: string
): Promise<NoteView[]> {
	if (heads.length === 0) return [];
	const placeholders = heads.map(() => '?').join(',');
	const result = await db
		.prepare(
			`WITH RECURSIVE lineage AS (
				SELECT ${NOTE_COLUMNS}, last_surfaced_at, user_id
				FROM notes
				WHERE user_id = ? AND id IN (${placeholders})
				UNION
				SELECT p.id, p.content, p.creator, p.work, p.kind, p.book_id, p.page,
					p.posted, p.tags, p.replaces, p.source, p.created_at, p.updated_at,
					p.last_surfaced_at, p.user_id
				FROM notes p
				JOIN lineage child ON child.replaces = p.id
				WHERE p.user_id = ?
			)
			SELECT ${NOTE_COLUMNS}, last_surfaced_at FROM lineage`
		)
		.bind(userId, ...heads.map((note) => note.id), userId)
		.all<NoteRow>();
	return projectNoteLineage(heads, result.results ?? []);
}

export interface NoteQueryFilters {
	search?: string;
	posted?: number;
	/** Book id, or the sentinel 'none' for notes without a book. */
	book_id?: string;
	/** All tags must be present on the note (AND semantics). */
	tags?: string[];
	/** ISO date lower bound on created_at (inclusive). */
	from?: string;
	/** ISO date upper bound on created_at (inclusive). */
	to?: string;
}

export type NoteSort = 'newest' | 'oldest' | 'edited';

/**
 * Build the WHERE clause shared by getNotes and getNoteFacets.
 * `exclude` lets facet queries drop one dimension so counts for that
 * dimension reflect the other active filters (standard faceting).
 */
function buildNoteWhere(
	filters: NoteQueryFilters,
	userId: string,
	exclude: { tags?: boolean; book_id?: boolean } = {}
): { where: string; params: (string | number)[] } {
	let where = ` WHERE user_id = ?`;
	const params: (string | number)[] = [userId];

	if (filters.posted != null) {
		where += ` AND posted = ?`;
		params.push(filters.posted);
	}

	if (filters.book_id && !exclude.book_id) {
		if (filters.book_id === 'none') {
			where += ` AND book_id IS NULL`;
		} else {
			where += ` AND book_id = ?`;
			params.push(filters.book_id);
		}
	}

	if (filters.tags && filters.tags.length > 0 && !exclude.tags) {
		// Tags are stored as a JSON array string, e.g. ["attention","weil"].
		// Match the quoted form so "art" doesn't match "cartography".
		for (const tag of filters.tags) {
			where += ` AND tags LIKE ?`;
			params.push(`%"${tag}"%`);
		}
	}

	if (filters.search) {
		where += ` AND LOWER(content) LIKE LOWER(?)`;
		params.push(`%${filters.search}%`);
	}

	if (filters.from) {
		where += ` AND created_at >= ?`;
		params.push(filters.from);
	}

	if (filters.to) {
		where += ` AND created_at <= ?`;
		params.push(filters.to);
	}

	return { where, params };
}

const NOTE_SORT_SQL: Record<NoteSort, string> = {
	newest: 'created_at DESC',
	oldest: 'created_at ASC',
	edited: 'updated_at DESC',
};

export async function getNotes(
	db: D1Database,
	options: NoteQueryFilters & {
		limit?: number;
		offset?: number;
		sort?: NoteSort;
	} = {},
	userId: string
): Promise<{ data: NoteView[]; hasMore: boolean }> {
	if (!userId) return { data: [], hasMore: false };
	const limit = options.limit ?? 50;
	const offset = options.offset ?? 0;
	const orderBy = NOTE_SORT_SQL[options.sort ?? 'newest'];

	const { where, params } = buildNoteWhere(options, userId);
	const query = `SELECT id, content, creator, work, kind, book_id, page, posted, tags, replaces, source, created_at, updated_at, last_surfaced_at FROM notes${where}
		AND NOT EXISTS (SELECT 1 FROM notes successor WHERE successor.replaces = notes.id AND successor.user_id = ?)
		ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
	params.push(userId);
	params.push(limit + 1, offset);

	const result = await db
		.prepare(query)
		.bind(...params)
		.all<NoteRow>();

	const rows = result.results ?? [];
	const hasMore = rows.length > limit;
	const heads = hasMore ? rows.slice(0, limit) : rows;
	return { data: await enrichNoteLineage(db, heads, userId), hasMore };
}

export interface NoteFacets {
	/** Total notes matching all active filters. */
	total: number;
	/** Tag usage counts (other filters applied, tag filter excluded). */
	tagCounts: { tag: string; count: number }[];
	/** Notes per book (other filters applied, book filter excluded). */
	bookCounts: { book_id: string; count: number }[];
	/** Notes per ISO year-week ('%Y-%W'), all filters applied. */
	activity: { week: string; count: number }[];
}

export async function getNoteFacets(
	db: D1Database,
	filters: NoteQueryFilters = {},
	userId: string
): Promise<NoteFacets> {
	if (!userId) {
		return { total: 0, tagCounts: [], bookCounts: [], activity: [] };
	}

	const all = buildNoteWhere(filters, userId);
	const noTags = buildNoteWhere(filters, userId, { tags: true });
	const noBook = buildNoteWhere(filters, userId, { book_id: true });

	const [totalRow, tagRows, bookRows, activityRows] = await Promise.all([
		db
			.prepare(`SELECT COUNT(*) as n FROM notes${all.where}`)
			.bind(...all.params)
			.first<{ n: number }>(),
		db
			.prepare(
				`SELECT tags FROM notes${noTags.where} AND tags IS NOT NULL AND tags != '[]'`
			)
			.bind(...noTags.params)
			.all<{ tags: string }>(),
		db
			.prepare(
				`SELECT book_id, COUNT(*) as n FROM notes${noBook.where} AND book_id IS NOT NULL GROUP BY book_id ORDER BY n DESC`
			)
			.bind(...noBook.params)
			.all<{ book_id: string; n: number }>(),
		db
			.prepare(
				`SELECT strftime('%Y-%W', created_at) as week, COUNT(*) as n FROM notes${all.where} GROUP BY week ORDER BY week ASC`
			)
			.bind(...all.params)
			.all<{ week: string; n: number }>(),
	]);

	const tagTally = new Map<string, number>();
	for (const row of tagRows.results ?? []) {
		try {
			const parsed: unknown = JSON.parse(row.tags);
			if (Array.isArray(parsed)) {
				for (const tag of parsed) {
					if (typeof tag === 'string' && tag) {
						tagTally.set(tag, (tagTally.get(tag) ?? 0) + 1);
					}
				}
			}
		} catch {
			// Skip malformed tags JSON
		}
	}

	return {
		total: totalRow?.n ?? 0,
		tagCounts: [...tagTally.entries()]
			.map(([tag, count]) => ({ tag, count }))
			.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
		bookCounts: (bookRows.results ?? []).map((r) => ({
			book_id: r.book_id,
			count: r.n,
		})),
		activity: (activityRows.results ?? []).map((r) => ({
			week: r.week,
			count: r.n,
		})),
	};
}

const NOTE_COLUMNS = `id, content, creator, work, kind, book_id, page, posted, tags, replaces, source, created_at, updated_at`;

/**
 * Shuffle mode: deal a weighted-random hand of notes from the whole corpus.
 *
 * - Only latest versions (notes not superseded via `replaces`).
 * - Notes created in the last `excludeDays` days are excluded (recency
 *   de-bias); if that leaves fewer than `count`, the exclusion is relaxed.
 * - Weight grows with time since the note was last surfaced (never-surfaced
 *   notes get the max weight), multiplied by a uniform random draw.
 * - Dealt notes get `last_surfaced_at` stamped AFTER selection, so the
 *   returned rows still carry the previous value ("last seen in March").
 */
export async function getShuffleNotes(
	db: D1Database,
	options: { count?: number; excludeDays?: number } = {},
	userId: string
): Promise<{ data: NoteView[]; total: number }> {
	if (!userId) return { data: [], total: 0 };
	const count = Math.min(Math.max(options.count ?? 5, 1), 20);
	const excludeDays = options.excludeDays ?? 30;

	// Latest-version notes only, tenant-scoped.
	const baseWhere = `WHERE n.user_id = ?
		AND NOT EXISTS (
			SELECT 1 FROM notes r WHERE r.replaces = n.id AND r.user_id = ?
		)`;

	// Weight: never-surfaced notes weigh 2.0; otherwise days-since-surfaced
	// scaled by a half-year horizon, capped at 2.0. Multiplying by a uniform
	// random gives an approximate weighted sample in a single query.
	const weightedOrder = `ORDER BY
		(CASE
			WHEN n.last_surfaced_at IS NULL THEN 2.0
			ELSE MIN(2.0, (julianday('now') - julianday(n.last_surfaced_at)) / 180.0)
		END) * (ABS(RANDOM()) / 9223372036854775807.0) DESC`;

	const selectCols = NOTE_COLUMNS.split(', ')
		.map((col) => `n.${col}`)
		.concat('n.last_surfaced_at')
		.join(', ');

	const dealt = await db
		.prepare(
			`SELECT ${selectCols} FROM notes n ${baseWhere}
			 AND n.created_at < datetime('now', ?)
			 ${weightedOrder} LIMIT ?`
		)
		.bind(userId, userId, `-${excludeDays} days`, count)
		.all<NoteRow>();

	let rows = dealt.results ?? [];

	// Young corpus fallback: not enough old notes — fill from the rest.
	if (rows.length < count) {
		const excludeIds = rows.map((r) => r.id);
		const placeholders = excludeIds.map(() => '?').join(',');
		const fill = await db
			.prepare(
				`SELECT ${selectCols} FROM notes n ${baseWhere}
				 ${excludeIds.length ? `AND n.id NOT IN (${placeholders})` : ''}
				 ${weightedOrder} LIMIT ?`
			)
			.bind(userId, userId, ...excludeIds, count - rows.length)
			.all<NoteRow>();
		rows = rows.concat(fill.results ?? []);
	}

	const totalRow = await db
		.prepare(`SELECT COUNT(*) as t FROM notes n ${baseWhere}`)
		.bind(userId, userId)
		.first<{ t: number }>();

	// Stamp the deal — after selection, so responses carry the prior value.
	if (rows.length > 0) {
		const now = new Date().toISOString();
		const placeholders = rows.map(() => '?').join(',');
		await db
			.prepare(
				`UPDATE notes SET last_surfaced_at = ? WHERE user_id = ? AND id IN (${placeholders})`
			)
			.bind(now, userId, ...rows.map((r) => r.id))
			.run();
	}

	return {
		data: await enrichNoteLineage(db, rows, userId),
		total: totalRow?.t ?? 0,
	};
}

export async function getNoteById(
	db: D1Database,
	id: string,
	userId: string
): Promise<NoteView | null> {
	if (!userId) return null;
	const result = await db
		.prepare(
			`SELECT id, content, creator, work, kind, book_id, page, posted, tags, replaces, source, created_at, updated_at, last_surfaced_at FROM notes WHERE id = ? AND user_id = ?`
		)
		.bind(id, userId)
		.first<NoteRow>();
	if (!result) {
		await auditCrossTenantAccess(db, 'notes', 'note', id, userId, 'READ');
		return null;
	}
	return (await enrichNoteLineage(db, [result], userId))[0];
}

export async function updateNote(
	db: D1Database,
	id: string,
	updates: Partial<NoteInput>,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const existing = await getNoteById(db, id, userId);
	if (!existing) throw new Error(`Note not found: ${id}`);

	const merged = {
		...existing,
		...updates,
		updated_at: new Date().toISOString(),
	};

	await db
		.prepare(
			`UPDATE notes SET content = ?, creator = ?, work = ?, kind = ?, book_id = ?, page = ?, posted = ?, tags = ?, replaces = ?, updated_at = ? WHERE id = ? AND user_id = ?`
		)
		.bind(
			merged.content,
			merged.creator || null,
			merged.work || null,
			merged.kind || null,
			merged.book_id || null,
			merged.page || null,
			merged.posted ?? 0,
			merged.tags || null,
			merged.replaces || null,
			merged.updated_at,
			id,
			userId
		)
		.run();
}

export async function deleteNote(
	db: D1Database,
	id: string,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const result = await db
		.prepare(`DELETE FROM notes WHERE id = ? AND user_id = ?`)
		.bind(id, userId)
		.run();
	if (result.meta.changes === 0) {
		await auditCrossTenantAccess(db, 'notes', 'note', id, userId, 'DELETE');
	}
}
