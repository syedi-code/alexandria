#!/usr/bin/env tsx
/**
 * Build the page search index from `pages`, in the separate SEARCH database.
 *
 * The index is derived data: a document is indexed again whenever the
 * transcription its rows were built from is no longer its current one. Applies
 * sql/search/ first, so the first run against a new database creates the schema.
 *
 * Usage:
 *   npm run pages:index -- --env <local|staging|production>
 *     [--budget ROWS] [--document ID]... [--force] [--dry-run]
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
	estimatePageIndexRows,
	pageIndexStatements,
} from '@alexandria/core/works';
import { parseRunOptions, runBudgeted } from './run.js';
import { executeSqlFile, query } from './wrangler.js';

const SEARCH_SCHEMA = path.resolve(import.meta.dirname, '../../sql/search');

interface Current {
	id: string;
	transcription_id: string;
	title: string;
	creator: string;
}

const options = parseRunOptions('pages:index');

if (!options.dryRun) {
	const files = (await readdir(SEARCH_SCHEMA))
		.filter((f) => f.endsWith('.sql'))
		.sort();
	for (const file of files) {
		await executeSqlFile(
			options.env,
			'search',
			path.join(SEARCH_SCHEMA, file)
		);
	}
}

const documents = await query<Current>(options.env, 'db', {
	sql: `SELECT d.id, d.current_transcription_id AS transcription_id, w.title, w.creator
	        FROM documents d JOIN works w ON w.id = d.work_id
	       WHERE d.current_transcription_id IS NOT NULL AND w.deleted_at IS NULL
	       ORDER BY w.creator, w.title`,
	params: [],
});

type IndexedRow = { document_id: string; transcription_id: string };
const indexedRows = await query<IndexedRow>(options.env, 'search', {
	sql: `SELECT document_id, transcription_id FROM indexed_documents`,
	params: [],
}).catch((error): IndexedRow[] => {
	// A dry run skips creating the schema, so a new database has nothing to read yet.
	if (options.dryRun) return [];
	throw error;
});
const indexed = new Map(
	indexedRows.map((row) => [row.document_id, row.transcription_id])
);

const queue = documents.filter(
	(d) =>
		(options.documents.length === 0 || options.documents.includes(d.id)) &&
		(options.force || indexed.get(d.id) !== d.transcription_id)
);

console.log(
	`${queue.length} of ${documents.length} documents to index on ${options.env}.\n`
);

await runBudgeted(queue, options, {
	label: (d) => `${d.creator} — ${d.title}`,
	prepare: async (d) => {
		const pages = await query<{ page_no: number; text: string }>(
			options.env,
			'db',
			{
				sql: `SELECT page_no, text FROM pages
			       WHERE transcription_id = ? AND text IS NOT NULL
			       ORDER BY page_no`,
				params: [d.transcription_id],
			}
		);
		return {
			database: 'search',
			statements: pageIndexStatements(
				{
					documentId: d.id,
					transcriptionId: d.transcription_id,
					pages,
				},
				new Date().toISOString()
			),
			estimate: estimatePageIndexRows(pages.length),
			summary: `${pages.length} pages with text`,
		};
	},
});
