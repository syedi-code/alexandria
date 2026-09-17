/// <reference types="@cloudflare/workers-types" />
import { documentObjectKey } from './documents.js';

/**
 * - `searchable`: the current transcription has text.
 * - `scan`: it was extracted and has none — readable only as images.
 * - `not_extracted`: no transcription yet.
 */
export type DocumentTextStatus = 'searchable' | 'scan' | 'not_extracted';

export interface DocumentSummary {
	document_id: string;
	label: string | null;
	page_count: number | null;
	page_offset: number;
	text: DocumentTextStatus;
	/** Whether a file backs it. A document row can exist before its upload. */
	has_file: boolean;
}

export interface WorkSummary {
	work_id: string;
	title: string;
	creator: string;
	originally_published: string | null;
	documents: DocumentSummary[];
}

export interface ReadableWorksInput {
	filter?: string;
	limit?: number;
}

export const DEFAULT_READABLE_WORKS_LIMIT = 50;
export const MAX_READABLE_WORKS_LIMIT = 200;

function textStatus(row: {
	has_transcription: 0 | 1;
	has_text: 0 | 1;
}): DocumentTextStatus {
	if (row.has_text) return 'searchable';
	return row.has_transcription ? 'scan' : 'not_extracted';
}

interface Row {
	work_id: string;
	title: string;
	creator: string;
	originally_published: string | null;
	document_id: string;
	label: string | null;
	page_count: number | null;
	page_offset: number;
	has_transcription: 0 | 1;
	has_text: 0 | 1;
	has_file: 0 | 1;
}

/** Works that have at least one document, primary document first. */
export async function listReadableWorks(
	db: D1Database,
	input: ReadableWorksInput = {}
): Promise<WorkSummary[]> {
	const limit = Math.min(
		Math.max(1, input.limit ?? DEFAULT_READABLE_WORKS_LIMIT),
		MAX_READABLE_WORKS_LIMIT
	);
	const filter = input.filter?.trim();

	const { results } = await db
		.prepare(
			`WITH selected AS (
			     SELECT w.id FROM works w
			      WHERE w.deleted_at IS NULL
			        AND EXISTS (SELECT 1 FROM documents d WHERE d.work_id = w.id)
			        ${filter ? `AND (w.title LIKE ?1 OR w.creator LIKE ?1)` : ''}
			      ORDER BY LOWER(w.creator), LOWER(w.title)
			      LIMIT ${filter ? '?2' : '?1'}
			 )
			 SELECT w.id AS work_id, w.title, w.creator, w.originally_published,
			        d.id AS document_id, d.label, d.page_count, d.page_offset,
			        d.current_transcription_id IS NOT NULL AS has_transcription,
			        d.r2_key IS NOT NULL AS has_file,
			        EXISTS (SELECT 1 FROM pages p
			                 WHERE p.transcription_id = d.current_transcription_id
			                   AND p.text IS NOT NULL) AS has_text
			   FROM selected s
			   JOIN works w ON w.id = s.id
			   JOIN documents d ON d.work_id = w.id
			  ORDER BY LOWER(w.creator), LOWER(w.title), d.is_primary DESC, d.created_at`
		)
		.bind(...(filter ? [`%${filter}%`, limit] : [limit]))
		.all<Row>();

	const works = new Map<string, WorkSummary>();
	for (const row of results ?? []) {
		const work = works.get(row.work_id) ?? {
			work_id: row.work_id,
			title: row.title,
			creator: row.creator,
			originally_published: row.originally_published,
			documents: [],
		};
		work.documents.push({
			document_id: row.document_id,
			label: row.label,
			page_count: row.page_count,
			page_offset: row.page_offset,
			text: textStatus(row),
			has_file: row.has_file === 1,
		});
		works.set(row.work_id, work);
	}
	return [...works.values()];
}

export interface DocumentDetail extends DocumentSummary {
	work_id: string;
	work_title: string;
	creator: string;
	/** Bucket key for the PDF, for /files/sign. */
	file_key: string | null;
}

export async function getDocumentDetail(
	db: D1Database,
	documentId: string
): Promise<DocumentDetail | null> {
	const row = await db
		.prepare(
			`SELECT d.id AS document_id, d.label, d.page_count, d.page_offset, d.r2_key,
			        d.r2_key IS NOT NULL AS has_file,
			        d.current_transcription_id IS NOT NULL AS has_transcription,
			        EXISTS (SELECT 1 FROM pages p
			                 WHERE p.transcription_id = d.current_transcription_id
			                   AND p.text IS NOT NULL) AS has_text,
			        w.id AS work_id, w.title AS work_title, w.creator
			   FROM documents d JOIN works w ON w.id = d.work_id
			  WHERE d.id = ?`
		)
		.bind(documentId)
		.first<Row & { r2_key: string | null; work_title: string }>();
	if (!row) return null;

	return {
		document_id: row.document_id,
		label: row.label,
		page_count: row.page_count,
		page_offset: row.page_offset,
		text: textStatus(row),
		has_file: row.has_file === 1,
		work_id: row.work_id,
		work_title: row.work_title,
		creator: row.creator,
		file_key: row.r2_key ? documentObjectKey(row.r2_key) : null,
	};
}
