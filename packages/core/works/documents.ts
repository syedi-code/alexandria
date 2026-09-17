/// <reference types="@cloudflare/workers-types" />
import type { DocumentRow, DocumentInput, DocumentPatch } from './schema.js';

const COLUMNS = `id, work_id, r2_key, label, page_offset, page_count,
	is_primary, current_transcription_id, created_at, updated_at`;

/**
 * The bucket key for a document's file. Rows carried over from books.pdf_url
 * hold the URL path (`/files/books/...`) that stylus still receives as
 * `pdf_url`, so the column can't be rewritten; it is normalised here instead.
 */
export function documentObjectKey(r2Key: string): string {
	return r2Key.replace(/^\/?(api\/)?files\//, '').replace(/^\/+/, '');
}

export async function listDocuments(
	db: D1Database,
	workId: string
): Promise<DocumentRow[]> {
	const result = await db
		.prepare(
			`SELECT ${COLUMNS} FROM documents WHERE work_id = ?
			  ORDER BY is_primary DESC, created_at ASC`
		)
		.bind(workId)
		.all<DocumentRow>();
	return result.results ?? [];
}

export async function getDocumentById(
	db: D1Database,
	id: string
): Promise<DocumentRow | null> {
	const row = await db
		.prepare(`SELECT ${COLUMNS} FROM documents WHERE id = ?`)
		.bind(id)
		.first<DocumentRow>();
	return row || null;
}

export async function createDocument(
	db: D1Database,
	workId: string,
	input: DocumentInput
): Promise<DocumentRow> {
	const now = new Date().toISOString();
	const row: DocumentRow = {
		id: input.id || crypto.randomUUID(),
		work_id: workId,
		r2_key: input.r2_key ?? null,
		label: input.label ?? null,
		page_offset: input.page_offset ?? 0,
		page_count: input.page_count ?? null,
		is_primary: input.is_primary ?? 0,
		current_transcription_id: null,
		created_at: now,
		updated_at: now,
	};

	await db
		.prepare(
			`INSERT INTO documents (id, work_id, r2_key, label, page_offset, page_count,
			                        is_primary, current_transcription_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
		)
		.bind(
			row.id,
			row.work_id,
			row.r2_key,
			row.label,
			row.page_offset,
			row.page_count,
			row.is_primary,
			row.created_at,
			row.updated_at
		)
		.run();

	return row;
}

export async function updateDocument(
	db: D1Database,
	id: string,
	patch: DocumentPatch
): Promise<void> {
	const sets: string[] = [];
	const params: (string | number | null)[] = [];
	const set = (column: string, value: string | number | null) => {
		sets.push(`${column} = ?`);
		params.push(value);
	};

	if (patch.r2_key !== undefined) set('r2_key', patch.r2_key ?? null);
	if (patch.label !== undefined) set('label', patch.label ?? null);
	if (patch.page_offset !== undefined) set('page_offset', patch.page_offset);
	if (patch.page_count !== undefined)
		set('page_count', patch.page_count ?? null);
	if (patch.is_primary !== undefined) set('is_primary', patch.is_primary);
	if (sets.length === 0) return;

	set('updated_at', new Date().toISOString());
	params.push(id);
	await db
		.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`)
		.bind(...params)
		.run();
}

export async function deleteDocument(
	db: D1Database,
	id: string
): Promise<void> {
	await db
		.prepare(
			`UPDATE works SET primary_document_id = NULL WHERE primary_document_id = ?`
		)
		.bind(id)
		.run();
	await db.prepare(`DELETE FROM documents WHERE id = ?`).bind(id).run();
}

export async function setPrimaryDocument(
	db: D1Database,
	workId: string,
	documentId: string
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.prepare(
			`UPDATE documents SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = ?
			  WHERE work_id = ?`
		)
		.bind(documentId, now, workId)
		.run();
	await db
		.prepare(
			`UPDATE works SET primary_document_id = ?, updated_at = ? WHERE id = ?`
		)
		.bind(documentId, now, workId)
		.run();
}

/**
 * The write path behind the Book facade's `pdf_url` and `pdf_page_offset`:
 * a Book has one file, so setting either creates or updates the primary
 * document rather than adding a second one.
 */
export async function upsertPrimaryDocument(
	db: D1Database,
	workId: string,
	fields: { r2_key?: string | null; page_offset?: number }
): Promise<DocumentRow | null> {
	const existing = (await listDocuments(db, workId)).find(
		(d) => d.is_primary === 1
	);

	if (existing) {
		await updateDocument(db, existing.id, fields);
		return getDocumentById(db, existing.id);
	}
	if (!fields.r2_key) return null;

	const created = await createDocument(db, workId, {
		r2_key: fields.r2_key,
		page_offset: fields.page_offset ?? 0,
		is_primary: 1,
	});
	await setPrimaryDocument(db, workId, created.id);
	return created;
}
