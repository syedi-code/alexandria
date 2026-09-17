/// <reference types="@cloudflare/workers-types" />
import {
	insertRows,
	runStatements,
	type SqlStatement,
} from '../platform/sql.js';
import { printedPage, type PageRef } from './pages.js';
import { ToolUnavailableError } from './tool-errors.js';

export interface SearchHit {
	ref: PageRef;
	work_id: string;
	work_title: string;
	creator: string;
	printed_page: string | null;
	/** Around the best match, with matched terms wrapped in «guillemets». */
	snippet: string;
	/** bm25; lower is a better match. */
	score: number;
}

export interface SearchInput {
	query: string;
	work_ids?: string[];
	document_ids?: string[];
	limit?: number;
}

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 25;

const FTS_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/**
 * Turns free text into an FTS5 expression that cannot be a syntax error:
 * `"quoted phrases"` stay phrases, every other word is quoted on its own, and
 * all terms are OR-ed so bm25 ranks pages that match more of them higher.
 */
export function toMatchExpression(query: string): string | null {
	const terms: string[] = [];
	const phrase = /"([^"]*)"/g;

	for (const [, text] of query.matchAll(phrase)) {
		const words = text.match(/[\p{L}\p{N}]+/gu);
		if (words) terms.push(words.join(' '));
	}
	for (const word of query.replace(phrase, ' ').match(/[\p{L}\p{N}]+/gu) ??
		[]) {
		if (!FTS_OPERATORS.has(word)) terms.push(word);
	}

	const unique = [...new Set(terms)];
	return unique.length ? unique.map((t) => `"${t}"`).join(' OR ') : null;
}

interface HitRow {
	document_id: string;
	page_no: number;
	snippet: string;
	score: number;
}

interface DocumentWorkRow {
	document_id: string;
	page_offset: number;
	work_id: string;
	work_title: string;
	creator: string;
}

const placeholders = (values: readonly unknown[]) =>
	values.map(() => '?').join(', ');

async function documentsForWorks(
	db: D1Database,
	workIds: readonly string[]
): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT id FROM documents WHERE work_id IN (${placeholders(workIds)})`
		)
		.bind(...workIds)
		.all<{ id: string }>();
	return (results ?? []).map((r) => r.id);
}

/**
 * The index is built by `npm run pages:index`, which also creates its schema,
 * so both an empty index and a missing one mean the same thing: nobody has
 * built it yet. Saying so beats reporting "no matches" over an empty index.
 */
async function assertIndexBuilt(search: D1Database): Promise<void> {
	const indexed = await search
		.prepare(`SELECT COUNT(*) AS n FROM indexed_documents`)
		.first<{ n: number }>()
		.catch(() => null);
	if (!indexed?.n) {
		throw new ToolUnavailableError(
			'The page search index has not been built yet, so no page can be found by searching. Reading pages still works.'
		);
	}
}

/** A query against an index that may not exist yet. */
async function queryIndex(
	search: D1Database,
	sql: string,
	params: (string | number)[]
) {
	try {
		return await search
			.prepare(sql)
			.bind(...params)
			.all<HitRow>();
	} catch (error) {
		await assertIndexBuilt(search);
		throw error;
	}
}

/**
 * Keyword search over page text. `search` is the SEARCH database; `db` is the
 * main one, used to scope by work and to name what was found.
 */
export async function searchPages(
	search: D1Database,
	db: D1Database,
	input: SearchInput
): Promise<SearchHit[]> {
	const match = toMatchExpression(input.query);
	if (!match) return [];

	const limit = Math.min(
		Math.max(1, input.limit ?? DEFAULT_SEARCH_LIMIT),
		MAX_SEARCH_LIMIT
	);

	let scope = input.document_ids?.length ? [...input.document_ids] : null;
	if (input.work_ids?.length) {
		const fromWorks = await documentsForWorks(db, input.work_ids);
		scope = scope
			? scope.filter((id) => fromWorks.includes(id))
			: fromWorks;
		if (scope.length === 0) return [];
	}

	const { results: hits } = await queryIndex(
		search,
		`SELECT document_id, page_no,
		        snippet(page_search, 2, '«', '»', '…', 32) AS snippet,
		        bm25(page_search) AS score
		   FROM page_search
		  WHERE page_search MATCH ?
		  ${scope ? `AND document_id IN (${placeholders(scope)})` : ''}
		  ORDER BY score
		  LIMIT ?`,
		[match, ...(scope ?? []), limit]
	);
	if (!hits?.length) {
		await assertIndexBuilt(search);
		return [];
	}

	const documentIds = [...new Set(hits.map((h) => h.document_id))];
	const { results: documents } = await db
		.prepare(
			`SELECT d.id AS document_id, d.page_offset,
			        w.id AS work_id, w.title AS work_title, w.creator
			   FROM documents d JOIN works w ON w.id = d.work_id
			  WHERE d.id IN (${placeholders(documentIds)})`
		)
		.bind(...documentIds)
		.all<DocumentWorkRow>();
	const byId = new Map((documents ?? []).map((d) => [d.document_id, d]));

	return hits.flatMap((hit) => {
		const document = byId.get(hit.document_id);
		if (!document) return [];
		return [
			{
				ref: { document_id: hit.document_id, page_no: hit.page_no },
				work_id: document.work_id,
				work_title: document.work_title,
				creator: document.creator,
				printed_page: printedPage(hit.page_no, document.page_offset),
				snippet: hit.snippet,
				score: hit.score,
			},
		];
	});
}

export interface PageIndexInput {
	documentId: string;
	transcriptionId: string;
	pages: readonly { page_no: number; text: string }[];
}

/** Replaces one document's rows in the search index. */
export function pageIndexStatements(
	input: PageIndexInput,
	now: string
): SqlStatement[] {
	return [
		{
			sql: `DELETE FROM page_search WHERE document_id = ?`,
			params: [input.documentId],
		},
		...insertRows(
			'page_search',
			['document_id', 'page_no', 'text'],
			input.pages.map((p) => [input.documentId, p.page_no, p.text])
		),
		{
			sql: `INSERT INTO indexed_documents (document_id, transcription_id, page_count, indexed_at)
			      VALUES (?, ?, ?, ?)
			      ON CONFLICT (document_id) DO UPDATE SET
			          transcription_id = excluded.transcription_id,
			          page_count = excluded.page_count,
			          indexed_at = excluded.indexed_at`,
			params: [
				input.documentId,
				input.transcriptionId,
				input.pages.length,
				now,
			],
		},
	];
}

/**
 * A guess until the first production run: local counts are one row per page,
 * and production billed text-layer writes at double their local count. FTS5's
 * shadow tables may add more. The budget counts what D1 actually reports, so
 * a low guess only lets one document run over.
 */
export function estimatePageIndexRows(pageCount: number): number {
	return pageCount * 2 + 2;
}

export async function indexDocumentPages(
	search: D1Database,
	input: PageIndexInput
): Promise<number> {
	return runStatements(
		search,
		pageIndexStatements(input, new Date().toISOString())
	);
}

/** Documents whose index rows were built from the given transcription. */
export async function listIndexedDocuments(
	search: D1Database
): Promise<Map<string, string>> {
	const { results } = await search
		.prepare(`SELECT document_id, transcription_id FROM indexed_documents`)
		.all<{ document_id: string; transcription_id: string }>();
	return new Map(
		(results ?? []).map((r) => [r.document_id, r.transcription_id])
	);
}
