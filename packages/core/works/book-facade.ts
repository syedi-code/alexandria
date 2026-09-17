/// <reference types="@cloudflare/workers-types" />
/**
 * The Book facade (plan D7).
 *
 * A Book is a Work whose kind is `book`. This module is the one place where
 * the old vocabulary survives — `author` for creator, `cover_url` for
 * cover_key, `pdf_url` and `pdf_page_offset` for the primary document's
 * r2_key and page_offset, `path` for an attachment's r2_key.
 *
 * It exists so stylus keeps receiving exactly the payload it received before
 * the Work model landed. Anything new should read works/ directly; nothing
 * new should be added here.
 */
import type {
	Book,
	BookInput,
	BookPatch,
	BookMediaInput,
	BookMediaPatch,
	BookMediaRow,
	WorkMediaRow,
} from './schema.js';
import { createWork, getWorkById, updateWork, deleteWork } from './works.js';
import { upsertPrimaryDocument } from './documents.js';
import {
	listWorkMedia,
	getWorkMediaById,
	createWorkMedia,
	updateWorkMedia,
	deleteWorkMedia,
} from './work-media.js';

/**
 * Every Book column, aliased out of works and its primary document. Kept as
 * one string so the projection cannot drift between the list and detail reads.
 */
export const BOOK_COLUMNS = `
	w.id, w.title, w.creator AS author, d.r2_key AS pdf_url,
	w.cover_key AS cover_url, w.isbn, w.description, w.originally_published,
	COALESCE(d.page_offset, 0) AS pdf_page_offset, w.creator_id AS author_id,
	w.created_at, w.updated_at`;

export const BOOK_FROM = `
	FROM works w
	LEFT JOIN documents d ON d.id = w.primary_document_id`;

export const BOOK_WHERE = `w.kind = 'book' AND w.deleted_at IS NULL`;

export function toBookMedia(row: WorkMediaRow): BookMediaRow {
	return {
		id: row.id,
		book_id: row.work_id,
		path: row.r2_key,
		kind: row.kind,
		caption: row.caption,
		sort_order: row.sort_order,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export async function getBooks(
	db: D1Database,
	options: { limit?: number; offset?: number; search?: string } = {}
): Promise<Book[]> {
	const where = [BOOK_WHERE];
	const params: (string | number)[] = [];

	if (options.search) {
		where.push(
			'(LOWER(w.title) LIKE LOWER(?) OR LOWER(w.creator) LIKE LOWER(?))'
		);
		params.push(`%${options.search}%`, `%${options.search}%`);
	}
	params.push(options.limit ?? 100, options.offset ?? 0);

	const result = await db
		.prepare(
			`SELECT ${BOOK_COLUMNS} ${BOOK_FROM}
			  WHERE ${where.join(' AND ')}
			  ORDER BY w.created_at DESC LIMIT ? OFFSET ?`
		)
		.bind(...params)
		.all<Book>();

	return result.results ?? [];
}

/**
 * Resolves a soft-deleted work, unlike the listing. Essay prose cites work ids
 * directly, so an id that once rendered has to keep rendering.
 */
export async function getBookById(
	db: D1Database,
	id: string
): Promise<Book | null> {
	const row = await db
		.prepare(
			`SELECT ${BOOK_COLUMNS} ${BOOK_FROM} WHERE w.id = ? AND w.kind = 'book'`
		)
		.bind(id)
		.first<Book>();
	return row || null;
}

export async function getBooksByAuthorId(
	db: D1Database,
	creatorId: string
): Promise<Book[]> {
	const result = await db
		.prepare(
			`SELECT ${BOOK_COLUMNS} ${BOOK_FROM}
			  WHERE ${BOOK_WHERE} AND w.creator_id = ?
			  ORDER BY w.created_at DESC`
		)
		.bind(creatorId)
		.all<Book>();
	return result.results ?? [];
}

export async function createBook(
	db: D1Database,
	input: BookInput,
	userId?: string
): Promise<Book> {
	const work = await createWork(
		db,
		{
			id: input.id,
			kind: 'book',
			title: input.title,
			creator: input.author,
			creator_id: input.author_id,
			originally_published: input.originally_published,
			isbn: input.isbn,
			description: input.description,
			cover_key: input.cover_url,
		},
		userId
	);

	if (input.pdf_url || input.pdf_page_offset) {
		await upsertPrimaryDocument(db, work.id, {
			r2_key: input.pdf_url ?? null,
			page_offset: input.pdf_page_offset ?? 0,
		});
	}

	return (await getBookById(db, work.id))!;
}

export async function updateBook(
	db: D1Database,
	id: string,
	updates: BookPatch
): Promise<void> {
	const existing = await getWorkById(db, id);
	if (!existing) throw new Error(`Book not found: ${id}`);

	await updateWork(db, id, {
		title: updates.title,
		creator: updates.author,
		creator_id: updates.author_id,
		originally_published: updates.originally_published,
		isbn: updates.isbn,
		description: updates.description,
		cover_key: updates.cover_url,
	});

	if (
		updates.pdf_url !== undefined ||
		updates.pdf_page_offset !== undefined
	) {
		const document = await upsertPrimaryDocument(db, id, {
			r2_key: updates.pdf_url,
			page_offset: updates.pdf_page_offset,
		});
		if (document && existing.primary_document_id !== document.id) {
			await updateWork(db, id, { primary_document_id: document.id });
		}
	}
}

export async function deleteBook(db: D1Database, id: string): Promise<void> {
	await deleteWork(db, id);
}

export async function listBookMedia(
	db: D1Database,
	workId: string
): Promise<BookMediaRow[]> {
	return (await listWorkMedia(db, workId)).map(toBookMedia);
}

export async function getBookMediaById(
	db: D1Database,
	mediaId: string
): Promise<BookMediaRow | null> {
	const row = await getWorkMediaById(db, mediaId);
	return row ? toBookMedia(row) : null;
}

export async function createBookMedia(
	db: D1Database,
	workId: string,
	input: BookMediaInput,
	userId: string
): Promise<BookMediaRow> {
	const row = await createWorkMedia(
		db,
		workId,
		{
			id: input.id,
			r2_key: input.path,
			kind: input.kind,
			caption: input.caption,
			sort_order: input.sort_order,
		},
		userId
	);
	return toBookMedia(row);
}

export async function updateBookMedia(
	db: D1Database,
	mediaId: string,
	patch: BookMediaPatch
): Promise<void> {
	await updateWorkMedia(db, mediaId, patch);
}

export async function deleteBookMedia(
	db: D1Database,
	mediaId: string
): Promise<void> {
	await deleteWorkMedia(db, mediaId);
}
