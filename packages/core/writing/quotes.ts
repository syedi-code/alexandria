/// <reference types="@cloudflare/workers-types" />
import type {
	QuoteInput,
	QuoteRow,
	ConnectionInput,
	EntityType,
} from './schema.js';
import { auditCrossTenantAccess } from './_shared.js';
import { createConnection } from './connections.js';

export async function createQuote(
	db: D1Database,
	input: QuoteInput,
	connections?: ConnectionInput[],
	userId?: string
): Promise<QuoteRow> {
	const now = new Date().toISOString();
	const quote: QuoteRow = {
		id: input.id || crypto.randomUUID(),
		quote: input.quote,
		work: input.work,
		creator: input.creator,
		kind: input.kind,
		book_id: input.book_id,
		page: input.page,
		posted: input.posted ?? 0,
		tags: input.tags,
		source: input.source ?? 'web',
		created_at: now,
		updated_at: now,
	};

	await db
		.prepare(
			`INSERT INTO quotes (id, quote, work, creator, kind, book_id, page, posted, tags, source, created_at, updated_at, user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			quote.id,
			quote.quote,
			quote.work || null,
			quote.creator || null,
			quote.kind || null,
			quote.book_id || null,
			quote.page || null,
			quote.posted,
			quote.tags || null,
			quote.source,
			quote.created_at,
			quote.updated_at,
			userId || null
		)
		.run();

	if (connections && connections.length > 0) {
		for (const conn of connections) {
			await createConnection(db, conn, userId);
		}
	} else if (quote.book_id) {
		const metadata = quote.page
			? JSON.stringify({ page: quote.page })
			: undefined;
		await createConnection(
			db,
			{
				a_type: 'book' as EntityType,
				a_id: quote.book_id,
				b_type: 'quote' as EntityType,
				b_id: quote.id,
				metadata,
			},
			userId
		);
	}

	return quote;
}

export async function getQuotes(
	db: D1Database,
	options: {
		limit?: number;
		offset?: number;
		search?: string;
		posted?: number;
		book_id?: string;
		/** When true, exclude superseded versions (rows another quote `replaces`). */
		latest_only?: boolean;
	} = {},
	userId: string
): Promise<QuoteRow[]> {
	if (!userId) return [];
	const limit = options.limit ?? 50;
	const offset = options.offset ?? 0;

	let query = `SELECT id, quote, work, creator, kind, book_id, page, posted, tags, replaces, source, created_at, updated_at FROM quotes WHERE 1=1 AND user_id = ?`;
	const params: (string | number)[] = [userId];

	if (options.posted != null) {
		query += ` AND posted = ?`;
		params.push(options.posted);
	}

	if (options.book_id) {
		query += ` AND book_id = ?`;
		params.push(options.book_id);
	}

	if (options.latest_only) {
		query += ` AND id NOT IN (SELECT replaces FROM quotes WHERE replaces IS NOT NULL)`;
	}

	if (options.search) {
		query += ` AND (LOWER(quote) LIKE LOWER(?) OR LOWER(work) LIKE LOWER(?) OR LOWER(creator) LIKE LOWER(?))`;
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
		.all<QuoteRow>();

	return result.results ?? [];
}

export async function getQuoteById(
	db: D1Database,
	id: string,
	userId: string
): Promise<QuoteRow | null> {
	if (!userId) return null;
	const result = await db
		.prepare(
			`SELECT id, quote, work, creator, kind, book_id, page, posted, tags, replaces, source, created_at, updated_at FROM quotes WHERE id = ? AND user_id = ?`
		)
		.bind(id, userId)
		.first<QuoteRow>();
	if (!result) {
		await auditCrossTenantAccess(db, 'quotes', 'quote', id, userId, 'READ');
		return null;
	}
	return result;
}

export async function updateQuote(
	db: D1Database,
	id: string,
	updates: Partial<QuoteInput>,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const existing = await getQuoteById(db, id, userId);
	if (!existing) throw new Error(`Quote not found: ${id}`);

	const merged = {
		...existing,
		...updates,
		updated_at: new Date().toISOString(),
	};

	await db
		.prepare(
			`UPDATE quotes SET quote = ?, work = ?, creator = ?, kind = ?, book_id = ?, page = ?, posted = ?, tags = ?, replaces = ?, updated_at = ? WHERE id = ? AND user_id = ?`
		)
		.bind(
			merged.quote,
			merged.work || null,
			merged.creator || null,
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

export async function deleteQuote(
	db: D1Database,
	id: string,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	const result = await db
		.prepare(`DELETE FROM quotes WHERE id = ? AND user_id = ?`)
		.bind(id, userId)
		.run();
	if (result.meta.changes === 0) {
		await auditCrossTenantAccess(
			db,
			'quotes',
			'quote',
			id,
			userId,
			'DELETE'
		);
	}
}
