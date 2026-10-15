/// <reference types="@cloudflare/workers-types" />
import type { Author, Book } from '../works/schema.js';
import { BOOK_COLUMNS, BOOK_FROM } from '../works/book-facade.js';
import { D1_MAX_BOUND_PARAMETERS } from '../platform/sql.js';

/** What a note card shows under the note: its book, or else its author. */
export interface NoteSources {
	book: Book | null;
	author: Author | null;
}

interface AuthorLink {
	a_type: string;
	a_id: string;
	b_id: string;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

const slots = (count: number) => Array(count).fill('?').join(', ');

/**
 * Notes with their sources resolved in two round trips. The client used to
 * fetch every book and every author one request at a time, after the notes.
 *
 * A note with a book shows the book, resolved even when soft-deleted, as
 * `GET /books/:id` does. A note without one shows the author its newest author
 * connection names.
 */
export async function withNoteSources<
	T extends { id?: string; book_id?: string | null },
>(
	db: D1Database,
	notes: readonly T[],
	userId: string
): Promise<(T & NoteSources)[]> {
	if (notes.length === 0) return [];

	const bookIds = [
		...new Set(
			notes.map((n) => n.book_id).filter((id): id is string => !!id)
		),
	];
	const unattributed = notes
		.filter((n) => n.id && !n.book_id)
		.map((n) => n.id as string);

	const bookReads = chunk(bookIds, D1_MAX_BOUND_PARAMETERS).map((ids) =>
		db
			.prepare(
				`SELECT ${BOOK_COLUMNS} ${BOOK_FROM}
				  WHERE w.kind = 'book' AND w.id IN (${slots(ids.length)})`
			)
			.bind(...ids)
	);
	// Every id is bound twice, once for each side of the connection.
	const linkReads = chunk(
		unattributed,
		Math.floor((D1_MAX_BOUND_PARAMETERS - 1) / 2)
	).map((ids) =>
		db
			.prepare(
				`SELECT a_type, a_id, b_id FROM connections
				  WHERE user_id = ?
				    AND ((a_type = 'note' AND b_type = 'author' AND a_id IN (${slots(ids.length)}))
				      OR (b_type = 'note' AND a_type = 'author' AND b_id IN (${slots(ids.length)})))
				  ORDER BY created_at DESC`
			)
			.bind(userId, ...ids, ...ids)
	);

	const reads = [...bookReads, ...linkReads];
	const results = reads.length ? await db.batch(reads) : [];

	const books = new Map<string, Book>();
	for (const { results: rows } of results.slice(0, bookReads.length)) {
		for (const book of rows as Book[]) books.set(book.id, book);
	}

	const authorIdByNote = new Map<string, string>();
	for (const { results: rows } of results.slice(bookReads.length)) {
		for (const link of rows as AuthorLink[]) {
			const [noteId, authorId] =
				link.a_type === 'note'
					? [link.a_id, link.b_id]
					: [link.b_id, link.a_id];
			if (!authorIdByNote.has(noteId))
				authorIdByNote.set(noteId, authorId);
		}
	}

	const authors = new Map<string, Author>();
	const authorIds = [...new Set(authorIdByNote.values())];
	for (const ids of chunk(authorIds, D1_MAX_BOUND_PARAMETERS)) {
		const { results: rows } = await db
			.prepare(
				`SELECT id, name, bio, born, died, created_at, updated_at
				   FROM creators WHERE id IN (${slots(ids.length)})`
			)
			.bind(...ids)
			.all<Author>();
		for (const author of rows ?? []) authors.set(author.id, author);
	}

	return notes.map((note) => ({
		...note,
		book: note.book_id ? (books.get(note.book_id) ?? null) : null,
		author: note.book_id
			? null
			: (authors.get(authorIdByNote.get(note.id) ?? '') ?? null),
	}));
}
