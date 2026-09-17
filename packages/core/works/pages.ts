/// <reference types="@cloudflare/workers-types" />

/** A page is always named by its document and 1-based PDF page index. */
export interface PageRef {
	document_id: string;
	page_no: number;
}

export interface PageText {
	ref: PageRef;
	work_id: string;
	work_title: string;
	creator: string;
	printed_page: string | null;
	/** Null when the page has no text layer. */
	text: string | null;
}

export const MAX_PAGES_PER_READ = 5;

/**
 * The page number printed on the paper, using the document's convention
 * `pdf_page = printed_page + page_offset`. Front matter before printed page 1
 * has none.
 */
export function printedPage(pageNo: number, pageOffset: number): string | null {
	const printed = pageNo - pageOffset;
	return printed >= 1 ? String(printed) : null;
}

export function describePage(page: Omit<PageText, 'text'>): string {
	const location = page.printed_page
		? `p. ${page.printed_page} (PDF p. ${page.ref.page_no})`
		: `PDF p. ${page.ref.page_no}`;
	return `${page.work_title} — ${page.creator} — ${location}`;
}

interface PageTextRow {
	document_id: string;
	page_no: number;
	text: string | null;
	page_offset: number;
	work_id: string;
	work_title: string;
	creator: string;
}

const PAGE_TEXT_SELECT = `
	SELECT d.id AS document_id, p.page_no, p.text, d.page_offset,
	       w.id AS work_id, w.title AS work_title, w.creator
	  FROM documents d
	  JOIN works w ON w.id = d.work_id
	  JOIN pages p ON p.transcription_id = d.current_transcription_id`;

function toPageText(row: PageTextRow): PageText {
	return {
		ref: { document_id: row.document_id, page_no: row.page_no },
		work_id: row.work_id,
		work_title: row.work_title,
		creator: row.creator,
		printed_page: printedPage(row.page_no, row.page_offset),
		text: row.text,
	};
}

export interface ReadPagesInput {
	document_id: string;
	from: number;
	to?: number;
}

/** Consecutive pages of one document, capped at MAX_PAGES_PER_READ. */
export async function readPages(
	db: D1Database,
	input: ReadPagesInput
): Promise<PageText[]> {
	const from = Math.max(1, input.from);
	const to = Math.min(
		Math.max(from, input.to ?? from),
		from + MAX_PAGES_PER_READ - 1
	);
	const { results } = await db
		.prepare(
			`${PAGE_TEXT_SELECT}
			 WHERE d.id = ? AND p.page_no BETWEEN ? AND ?
			 ORDER BY p.page_no`
		)
		.bind(input.document_id, from, to)
		.all<PageTextRow>();
	return (results ?? []).map(toPageText);
}

/** Specific pages of one document, in any order; missing pages are simply absent. */
export async function getPages(
	db: D1Database,
	documentId: string,
	pageNos: readonly number[]
): Promise<PageText[]> {
	const unique = [...new Set(pageNos)];
	if (unique.length === 0) return [];
	const { results } = await db
		.prepare(
			`${PAGE_TEXT_SELECT}
			 WHERE d.id = ? AND p.page_no IN (${unique.map(() => '?').join(', ')})`
		)
		.bind(documentId, ...unique)
		.all<PageTextRow>();
	return (results ?? []).map(toPageText);
}

export interface CurrentPageTexts {
	transcription_id: string;
	pages: { page_no: number; text: string }[];
}

/** Every page of a document's current transcription that has text; null if it has none. */
export async function listPageTexts(
	db: D1Database,
	documentId: string
): Promise<CurrentPageTexts | null> {
	const document = await db
		.prepare(`SELECT current_transcription_id FROM documents WHERE id = ?`)
		.bind(documentId)
		.first<{ current_transcription_id: string | null }>();
	const transcriptionId = document?.current_transcription_id;
	if (!transcriptionId) return null;

	const { results } = await db
		.prepare(
			`SELECT page_no, text FROM pages
			  WHERE transcription_id = ? AND text IS NOT NULL
			  ORDER BY page_no`
		)
		.bind(transcriptionId)
		.all<{ page_no: number; text: string }>();
	return { transcription_id: transcriptionId, pages: results ?? [] };
}
