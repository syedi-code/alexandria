/// <reference types="@cloudflare/workers-types" />
import type { Author, Book, BookMediaRow } from './schema.js';
import {
	BOOK_COLUMNS,
	BOOK_FROM,
	BOOK_WHERE,
	getBookById,
	listBookMedia,
} from './book-facade.js';
import { getCreatorById } from './creators.js';

export type LibraryDecade =
	| 'pre-1900'
	| '1900s'
	| '2000s'
	| '2010s'
	| '2020s'
	| 'unknown';

/**
 * Bucket a free-text "originally_published" value into a library decade.
 * Accepts ranges like "1975-76", "350 BCE", "c. 55 CE", "1966".
 */
export function deriveLibraryDecade(value?: string | null): LibraryDecade {
	if (!value) return 'unknown';
	const v = value.trim();
	if (/BCE/i.test(v)) return 'pre-1900';
	const match = v.match(/(\d{3,4})/);
	if (!match) return 'unknown';
	const year = parseInt(match[1], 10);
	if (Number.isNaN(year)) return 'unknown';
	if (year < 1900) return 'pre-1900';
	if (year < 2000) return '1900s';
	if (year < 2010) return '2000s';
	if (year < 2020) return '2010s';
	return '2020s';
}

export interface CatalogueRow extends Book {
	author_born: string | null;
	author_died: string | null;
	media_count: number;
	has_pdf: 0 | 1;
	decade: LibraryDecade;
}

export interface CatalogueListOptions {
	search?: string;
	decade?: LibraryDecade;
	hasPdf?: boolean;
	sort?: 'author_az' | 'recent' | 'year';
	limit?: number;
	offset?: number;
}

/**
 * The works-only half of the library listing: works, their creators and their
 * media. Quote, note and citation counts are writing's business — see
 * writing/enrichment.ts, which layers them on top of this.
 */
export async function listCatalogue(
	db: D1Database,
	options: CatalogueListOptions = {}
): Promise<{ rows: CatalogueRow[]; total: number }> {
	const { search, hasPdf, sort = 'author_az' } = options;
	const limit = options.limit ?? 500;
	const offset = options.offset ?? 0;

	const where: string[] = [BOOK_WHERE];
	const params: (string | number)[] = [];

	if (search) {
		where.push(
			'(LOWER(w.title) LIKE LOWER(?) OR LOWER(w.creator) LIKE LOWER(?))'
		);
		params.push(`%${search}%`, `%${search}%`);
	}
	if (hasPdf === true) where.push('d.r2_key IS NOT NULL');
	if (hasPdf === false) where.push('d.r2_key IS NULL');

	let orderBy: string;
	switch (sort) {
		case 'recent':
			orderBy = 'w.created_at DESC';
			break;
		case 'year':
			orderBy = 'w.originally_published ASC, w.title ASC';
			break;
		default:
			orderBy =
				'LOWER(w.creator) ASC, w.originally_published ASC, w.title ASC';
	}

	const sql = `
		SELECT ${BOOK_COLUMNS},
			c.born AS author_born, c.died AS author_died,
			COALESCE(mc.cnt, 0) AS media_count,
			CASE WHEN d.r2_key IS NULL THEN 0 ELSE 1 END AS has_pdf
		${BOOK_FROM}
		LEFT JOIN creators c ON c.id = w.creator_id
		LEFT JOIN (SELECT work_id, COUNT(*) AS cnt FROM work_media GROUP BY work_id) mc ON mc.work_id = w.id
		WHERE ${where.join(' AND ')}
		ORDER BY ${orderBy}
		LIMIT ? OFFSET ?
	`;
	params.push(limit, offset);

	const result = await db
		.prepare(sql)
		.bind(...params)
		.all<Omit<CatalogueRow, 'decade'>>();

	const rows = (result.results ?? []).map((r) => ({
		...r,
		decade: deriveLibraryDecade(r.originally_published),
	}));

	const total = await db
		.prepare(`SELECT COUNT(*) AS c FROM works w WHERE ${BOOK_WHERE}`)
		.first<{ c: number }>();

	return {
		rows: options.decade
			? rows.filter((r) => r.decade === options.decade)
			: rows,
		total: total?.c ?? 0,
	};
}

export interface CatalogueEntry {
	book: Book;
	author: Author | null;
	media: BookMediaRow[];
}

export async function getCatalogueEntry(
	db: D1Database,
	workId: string
): Promise<CatalogueEntry | null> {
	const book = await getBookById(db, workId);
	if (!book) return null;

	return {
		book,
		author: book.author_id
			? await getCreatorById(db, book.author_id)
			: null,
		media: await listBookMedia(db, workId),
	};
}
