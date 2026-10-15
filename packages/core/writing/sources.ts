/// <reference types="@cloudflare/workers-types" />
import type { Author, Book } from '../works/schema.js';
import { BOOK_COLUMNS, BOOK_FROM } from '../works/book-facade.js';
import { D1_MAX_BOUND_PARAMETERS } from '../platform/sql.js';

/** What a card shows under a note or a quote: its book, or else its author. */
export interface Sources {
	book: Book | null;
	author: Author | null;
}

interface Attributable {
	id?: string;
	book_id?: string | null;
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
 * Rows with their sources resolved in two round trips. The client used to
 * fetch every book and every author one request at a time, after the rows.
 *
 * A row with a book shows the book, resolved even when soft-deleted, as
 * `GET /books/:id` does. A row `wantsAuthor` accepts shows the author its
 * newest author connection names.
 */
async function withSources<T extends Attributable>(
	db: D1Database,
	entityType: 'note' | 'quote',
	rows: readonly T[],
	userId: string,
	wantsAuthor: (row: T) => boolean
): Promise<(T & Sources)[]> {
	if (rows.length === 0) return [];

	const bookIds = [
		...new Set(
			rows.map((r) => r.book_id).filter((id): id is string => !!id)
		),
	];
	const authored = rows
		.filter((r) => r.id && !r.book_id && wantsAuthor(r))
		.map((r) => r.id as string);

	const bookReads = chunk(bookIds, D1_MAX_BOUND_PARAMETERS).map((ids) =>
		db
			.prepare(
				`SELECT ${BOOK_COLUMNS} ${BOOK_FROM}
				  WHERE w.kind = 'book' AND w.id IN (${slots(ids.length)})`
			)
			.bind(...ids)
	);
	// Every id is bound twice, once for each side of the connection, after
	// the user and the entity type.
	const linkReads = chunk(
		authored,
		Math.floor((D1_MAX_BOUND_PARAMETERS - 2) / 2)
	).map((ids) =>
		db
			.prepare(
				`SELECT a_type, a_id, b_id FROM connections
				  WHERE user_id = ?1
				    AND ((a_type = ?2 AND b_type = 'author' AND a_id IN (${slots(ids.length)}))
				      OR (b_type = ?2 AND a_type = 'author' AND b_id IN (${slots(ids.length)})))
				  ORDER BY created_at DESC`
			)
			.bind(userId, entityType, ...ids, ...ids)
	);

	const reads = [...bookReads, ...linkReads];
	const results = reads.length ? await db.batch(reads) : [];

	const books = new Map<string, Book>();
	for (const { results: found } of results.slice(0, bookReads.length)) {
		for (const book of found as Book[]) books.set(book.id, book);
	}

	const authorIdByRow = new Map<string, string>();
	for (const { results: found } of results.slice(bookReads.length)) {
		for (const link of found as AuthorLink[]) {
			const [rowId, authorId] =
				link.a_type === entityType
					? [link.a_id, link.b_id]
					: [link.b_id, link.a_id];
			if (!authorIdByRow.has(rowId)) authorIdByRow.set(rowId, authorId);
		}
	}

	const authors = new Map<string, Author>();
	const authorIds = [...new Set(authorIdByRow.values())];
	for (const ids of chunk(authorIds, D1_MAX_BOUND_PARAMETERS)) {
		const { results: found } = await db
			.prepare(
				`SELECT id, name, bio, born, died, created_at, updated_at
				   FROM creators WHERE id IN (${slots(ids.length)})`
			)
			.bind(...ids)
			.all<Author>();
		for (const author of found ?? []) authors.set(author.id, author);
	}

	return rows.map((row) => {
		const authorId = row.id ? authorIdByRow.get(row.id) : undefined;
		return {
			...row,
			book: row.book_id ? (books.get(row.book_id) ?? null) : null,
			author: authorId ? (authors.get(authorId) ?? null) : null,
		};
	});
}

/** A note without a book is attributed to its connected author. */
export const withNoteSources = <T extends Attributable>(
	db: D1Database,
	notes: readonly T[],
	userId: string
) => withSources(db, 'note', notes, userId, () => true);

/** A quote names its creator inline; only one without is looked up. */
export const withQuoteSources = <T extends Attributable & { creator?: string }>(
	db: D1Database,
	quotes: readonly T[],
	userId: string
) => withSources(db, 'quote', quotes, userId, (quote) => !quote.creator);
