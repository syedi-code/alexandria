/// <reference types="@cloudflare/workers-types" />
import {
	insertRows,
	runStatements,
	type SqlStatement,
} from '../platform/sql.js';

/** The transcription model name for text read straight out of a PDF's text layer. */
export const TEXT_LAYER_MODEL = 'pdf-text-layer';

export interface TextLayer {
	documentId: string;
	/** Extractor and version, e.g. `unpdf@1.8.1`; stored as prompt_version. */
	extractor: string;
	/** Index 0 is PDF page 1. Null for a page with no text. */
	pages: readonly (string | null)[];
}

/** Text as stored: no NUL bytes (they end a SQLite literal), no whitespace-only pages. */
export function cleanPageText(text: string | null | undefined): string | null {
	const cleaned = (text ?? '')
		.replaceAll('\u0000', '')
		.replace(/\r\n?/g, '\n');
	return cleaned.trim() ? cleaned : null;
}

/**
 * Replaces a document's text-layer transcription in one pass. It becomes the
 * current transcription unless the document already points at a different,
 * still-existing one — a real transcription is never demoted by a re-extract.
 */
export function textLayerStatements(
	layer: TextLayer,
	{ transcriptionId, now }: { transcriptionId: string; now: string }
): SqlStatement[] {
	const { documentId } = layer;
	const pages = layer.pages.map(cleanPageText);

	return [
		{
			sql: `DELETE FROM pages WHERE transcription_id IN
			        (SELECT id FROM transcriptions WHERE document_id = ? AND model = ?)`,
			params: [documentId, TEXT_LAYER_MODEL],
		},
		{
			sql: `DELETE FROM transcriptions WHERE document_id = ? AND model = ?`,
			params: [documentId, TEXT_LAYER_MODEL],
		},
		{
			sql: `INSERT INTO transcriptions (id, document_id, model, prompt_version, status,
			                                  started_at, finished_at, cost, created_at, updated_at)
			      VALUES (?, ?, ?, ?, 'complete', ?, ?, 0, ?, ?)`,
			params: [
				transcriptionId,
				documentId,
				TEXT_LAYER_MODEL,
				layer.extractor,
				now,
				now,
				now,
				now,
			],
		},
		...insertRows(
			'pages',
			['transcription_id', 'page_no', 'text'],
			pages.map((text, i) => [transcriptionId, i + 1, text])
		),
		{
			sql: `UPDATE documents
			         SET page_count = ?,
			             updated_at = ?,
			             current_transcription_id = CASE
			                 WHEN current_transcription_id IN (SELECT id FROM transcriptions)
			                 THEN current_transcription_id
			                 ELSE ? END
			       WHERE id = ?`,
			params: [pages.length, now, transcriptionId, documentId],
		},
	];
}

/**
 * Rows D1 bills for a first extraction, measured against production over 70
 * documents: exactly four per page plus eight per document. That is double what
 * the same statements report locally. A re-extraction also pays for the rows it
 * deletes.
 */
export function estimateTextLayerRows(pageCount: number): number {
	return pageCount * 4 + 8;
}

export async function writeTextLayer(
	db: D1Database,
	layer: TextLayer
): Promise<{ transcriptionId: string; rowsWritten: number }> {
	const transcriptionId = crypto.randomUUID();
	const statements = textLayerStatements(layer, {
		transcriptionId,
		now: new Date().toISOString(),
	});
	return {
		transcriptionId,
		rowsWritten: await runStatements(db, statements),
	};
}
