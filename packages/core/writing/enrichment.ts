/// <reference types="@cloudflare/workers-types" />
import type { Author, Book, BookMediaRow } from '../works/schema.js';
import {
	listCatalogue,
	getCatalogueEntry,
	type CatalogueListOptions,
	type LibraryDecade,
} from '../works/catalogue.js';

export type { LibraryDecade };

/**
 * Writing's view of a work: how much has been written about it.
 *
 * This is the one direction the seam allows. Everything here reads works/
 * tables by opaque id and joins them to quotes, notes and essays. Nothing in
 * works/ may import this file — see the boundary lint rule.
 */
export interface WorkEnrichment {
	quote_count: number;
	note_count: number;
	citation_count: number;
	last_quote_at: string | null;
	last_note_at: string | null;
}

const EMPTY_ENRICHMENT: WorkEnrichment = {
	quote_count: 0,
	note_count: 0,
	citation_count: 0,
	last_quote_at: null,
	last_note_at: null,
};

/**
 * Counts for every referenced work in one pass. Grouping over the whole table
 * rather than binding a list of ids keeps this to a single statement whatever
 * the page size — D1 caps bound parameters well below a full catalogue page.
 */
export async function getWorkEnrichment(
	db: D1Database
): Promise<Map<string, WorkEnrichment>> {
	const result = await db
		.prepare(
			`SELECT 'quote' AS kind, book_id AS work_id, COUNT(*) AS cnt, MAX(created_at) AS last
			   FROM quotes
			  WHERE book_id IS NOT NULL
			    AND id NOT IN (SELECT replaces FROM quotes WHERE replaces IS NOT NULL)
			  GROUP BY book_id
			 UNION ALL
			 SELECT 'note', book_id, COUNT(*), MAX(created_at)
			   FROM notes
			  WHERE book_id IS NOT NULL
			    AND id NOT IN (SELECT replaces FROM notes WHERE replaces IS NOT NULL)
			  GROUP BY book_id
			 UNION ALL
			 SELECT 'citation', er.entity_id, COUNT(*), NULL
			   FROM essay_references er
			   JOIN essays e ON e.id = er.essay_id
			    AND e.id NOT IN (SELECT replaces FROM essays WHERE replaces IS NOT NULL)
			  WHERE er.entity_type = 'book'
			  GROUP BY er.entity_id`
		)
		.all<{
			kind: 'quote' | 'note' | 'citation';
			work_id: string;
			cnt: number;
			last: string | null;
		}>();

	const byWork = new Map<string, WorkEnrichment>();
	for (const row of result.results ?? []) {
		const entry = byWork.get(row.work_id) ?? { ...EMPTY_ENRICHMENT };
		if (row.kind === 'quote') {
			entry.quote_count = row.cnt;
			entry.last_quote_at = row.last;
		} else if (row.kind === 'note') {
			entry.note_count = row.cnt;
			entry.last_note_at = row.last;
		} else {
			entry.citation_count = row.cnt;
		}
		byWork.set(row.work_id, entry);
	}
	return byWork;
}

export interface LibraryBookRow extends Book {
	quote_count: number;
	note_count: number;
	citation_count: number;
	media_count: number;
	has_pdf: 0 | 1;
	decade: LibraryDecade;
	last_activity_at: string | null;
	author_born?: string | null;
	author_died?: string | null;
}

export type LibraryListOptions = CatalogueListOptions;

export async function getLibraryBooks(
	db: D1Database,
	options: LibraryListOptions = {}
): Promise<{
	books: LibraryBookRow[];
	totals: { books: number; quotes: number; notes: number };
}> {
	const [catalogue, enrichment] = await Promise.all([
		listCatalogue(db, options),
		getWorkEnrichment(db),
	]);

	const books = catalogue.rows.map((row) => {
		const e = enrichment.get(row.id) ?? EMPTY_ENRICHMENT;
		return {
			id: row.id,
			title: row.title,
			author: row.author,
			pdf_url: row.pdf_url,
			cover_url: row.cover_url,
			isbn: row.isbn,
			description: row.description,
			originally_published: row.originally_published,
			pdf_page_offset: row.pdf_page_offset,
			author_id: row.author_id,
			created_at: row.created_at,
			updated_at: row.updated_at,
			author_born: row.author_born,
			author_died: row.author_died,
			quote_count: e.quote_count,
			note_count: e.note_count,
			citation_count: e.citation_count,
			media_count: row.media_count,
			has_pdf: row.has_pdf,
			last_activity_at:
				e.last_quote_at ?? e.last_note_at ?? row.created_at,
			decade: row.decade,
		} as LibraryBookRow;
	});

	let quotes = 0;
	let notes = 0;
	for (const e of enrichment.values()) {
		quotes += e.quote_count;
		notes += e.note_count;
	}

	return { books, totals: { books: catalogue.total, quotes, notes } };
}

export interface BookDetailQuote {
	id: string;
	quote: string;
	page: string | null;
	created_at: string;
}
export interface BookDetailNote {
	id: string;
	content: string;
	page: string | null;
	created_at: string;
}
export interface BookDetailEssay {
	id: string;
	title: string;
	subtitle: string | null;
	page: string | null;
}
export interface BookDetailRelated {
	id: string;
	title: string;
	author: string;
	co_citations: number;
}
export interface BookDetail {
	book: Book;
	author: Author | null;
	quotes: BookDetailQuote[];
	notes: BookDetailNote[];
	essays: BookDetailEssay[];
	related: BookDetailRelated[];
	media: BookMediaRow[];
	stats: { quotes: number; notes: number; essays: number; media: number };
}

export async function getBookDetail(
	db: D1Database,
	bookId: string
): Promise<BookDetail | null> {
	const entry = await getCatalogueEntry(db, bookId);
	if (!entry) return null;

	const quotesRes = await db
		.prepare(
			`SELECT id, quote, page, created_at FROM quotes
			   WHERE book_id = ?
			     AND id NOT IN (SELECT replaces FROM quotes WHERE replaces IS NOT NULL)
			   ORDER BY created_at DESC LIMIT 50`
		)
		.bind(bookId)
		.all<BookDetailQuote>();
	const notesRes = await db
		.prepare(
			`SELECT id, content, page, created_at FROM notes
			   WHERE book_id = ?
			     AND id NOT IN (SELECT replaces FROM notes WHERE replaces IS NOT NULL)
			   ORDER BY created_at DESC LIMIT 50`
		)
		.bind(bookId)
		.all<BookDetailNote>();

	const essaysRes = await db
		.prepare(
			`SELECT e.id AS id,
			        SUBSTR(e.content, 1, 80) AS title,
			        NULL AS subtitle,
			        er.page AS page
			   FROM essay_references er
			   JOIN essays e ON e.id = er.essay_id
			    AND e.id NOT IN (SELECT replaces FROM essays WHERE replaces IS NOT NULL)
			   WHERE er.entity_type = 'book' AND er.entity_id = ?
			   ORDER BY er.position ASC, e.created_at DESC
			   LIMIT 50`
		)
		.bind(bookId)
		.all<BookDetailEssay>();

	const relatedRes = await db
		.prepare(
			`SELECT w.id AS id, w.title AS title, w.creator AS author, COUNT(*) AS co_citations
			   FROM essay_references er1
			   JOIN essays e1 ON e1.id = er1.essay_id
			    AND e1.id NOT IN (SELECT replaces FROM essays WHERE replaces IS NOT NULL)
			   JOIN essay_references er2 ON er2.essay_id = er1.essay_id
			   JOIN works w ON w.id = er2.entity_id AND w.deleted_at IS NULL
			   WHERE er1.entity_type = 'book' AND er1.entity_id = ?
			     AND er2.entity_type = 'book' AND er2.entity_id <> ?
			   GROUP BY w.id, w.title, w.creator
			   ORDER BY co_citations DESC, w.title ASC
			   LIMIT 5`
		)
		.bind(bookId, bookId)
		.all<BookDetailRelated>();

	const totalEssays = await db
		.prepare(
			`SELECT COUNT(*) AS c FROM essay_references er
			   JOIN essays e ON e.id = er.essay_id
			    AND e.id NOT IN (SELECT replaces FROM essays WHERE replaces IS NOT NULL)
			   WHERE er.entity_type = 'book' AND er.entity_id = ?`
		)
		.bind(bookId)
		.first<{ c: number }>();

	return {
		book: entry.book,
		author: entry.author,
		quotes: quotesRes.results ?? [],
		notes: notesRes.results ?? [],
		essays: essaysRes.results ?? [],
		related: relatedRes.results ?? [],
		media: entry.media,
		stats: {
			quotes: (quotesRes.results ?? []).length,
			notes: (notesRes.results ?? []).length,
			essays: totalEssays?.c ?? 0,
			media: entry.media.length,
		},
	};
}
