#!/usr/bin/env tsx
/**
 * Extract the text layer of every PDF into `transcriptions` and `pages`.
 *
 * Resumable and budgeted: documents that already have a complete text-layer
 * transcription are skipped, and the run stops before the document that would
 * take it past --budget rows written. Run it again the next day to continue.
 *
 * Usage:
 *   npm run pages:extract -- --env <local|staging|production>
 *     [--budget ROWS]    default 60,000 remote, unlimited local
 *     [--document ID]    only these documents; repeatable
 *     [--force]          re-extract documents that already have text
 *     [--dry-run]        download and extract, write nothing
 */
import {
	documentObjectKey,
	estimateTextLayerRows,
	TEXT_LAYER_MODEL,
	textLayerStatements,
} from '@alexandria/core/works';
import { parseRunOptions, runBudgeted } from './run.js';
import { EXTRACTOR, extractPageTexts } from './pdf-text.js';
import { downloadObject, query } from './wrangler.js';

interface Candidate {
	id: string;
	r2_key: string;
	title: string;
	creator: string;
	extracted: 0 | 1;
}

const options = parseRunOptions('pages:extract');

const candidates = await query<Candidate>(options.env, 'db', {
	sql: `SELECT d.id, d.r2_key, w.title, w.creator,
	             EXISTS (SELECT 1 FROM transcriptions t
	                      WHERE t.document_id = d.id AND t.model = ? AND t.status = 'complete') AS extracted
	        FROM documents d JOIN works w ON w.id = d.work_id
	       WHERE d.r2_key IS NOT NULL AND w.deleted_at IS NULL
	       ORDER BY w.creator, w.title`,
	params: [TEXT_LAYER_MODEL],
});

const queue = candidates.filter(
	(d) =>
		(options.documents.length === 0 || options.documents.includes(d.id)) &&
		(options.force || !d.extracted)
);

console.log(
	`${queue.length} of ${candidates.length} documents to extract on ${options.env}.\n`
);

await runBudgeted(queue, options, {
	label: (d) => `${d.creator} — ${d.title}`,
	prepare: async (d) => {
		const pdf = await downloadObject(
			options.env,
			documentObjectKey(d.r2_key)
		);
		const pages = await extractPageTexts(pdf);
		const blank = pages.filter((text) => !text.trim()).length;

		return {
			database: 'db',
			statements: textLayerStatements(
				{ documentId: d.id, extractor: EXTRACTOR, pages },
				{
					transcriptionId: crypto.randomUUID(),
					now: new Date().toISOString(),
				}
			),
			estimate: estimateTextLayerRows(pages.length),
			summary:
				blank === pages.length
					? `${pages.length} pages, no text layer (a scan)`
					: `${pages.length} pages${blank ? `, ${blank} blank` : ''}`,
		};
	},
});
