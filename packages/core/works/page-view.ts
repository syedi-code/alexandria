/// <reference types="@cloudflare/workers-types" />
import { PDFDocument } from 'pdf-lib';
import { documentObjectKey } from './documents.js';
import type { PageRef } from './pages.js';

export type ViewablePage = { ok: true; media_type: string; data: Uint8Array };
export type UnviewablePage = {
	ok: false;
	reason: 'no_such_page' | 'no_source' | 'too_large';
};
export type PageView = ViewablePage | UnviewablePage;

/** Narrowing on `ok` needs strictNullChecks, which this codebase has off. */
export const isViewable = (view: PageView): view is ViewablePage => view.ok;

/**
 * Cutting a page out of a PDF loads the whole file into a 128 MB worker
 * isolate. Above this, a page is only viewable once it has a rendered image.
 */
export const MAX_SLICEABLE_PDF_BYTES = 24 * 1024 * 1024;

interface SourceRow {
	r2_key: string | null;
	page_count: number | null;
	image_key: string | null;
}

export async function viewPage(
	env: { DB: D1Database; R2_BUCKET?: R2Bucket },
	ref: PageRef
): Promise<PageView> {
	const source = await env.DB.prepare(
		`SELECT d.r2_key, d.page_count, p.image_key
		   FROM documents d
		   LEFT JOIN pages p ON p.transcription_id = d.current_transcription_id
		                    AND p.page_no = ?
		  WHERE d.id = ?`
	)
		.bind(ref.page_no, ref.document_id)
		.first<SourceRow>();

	if (!source || ref.page_no < 1)
		return { ok: false, reason: 'no_such_page' };
	if (source.page_count !== null && ref.page_no > source.page_count) {
		return { ok: false, reason: 'no_such_page' };
	}
	if (!env.R2_BUCKET) return { ok: false, reason: 'no_source' };

	if (source.image_key) {
		const image = await env.R2_BUCKET.get(source.image_key);
		if (image) {
			return {
				ok: true,
				media_type: image.httpMetadata?.contentType ?? 'image/webp',
				data: new Uint8Array(await image.arrayBuffer()),
			};
		}
	}

	if (!source.r2_key) return { ok: false, reason: 'no_source' };
	const key = documentObjectKey(source.r2_key);
	const head = await env.R2_BUCKET.head(key);
	if (!head) return { ok: false, reason: 'no_source' };
	if (head.size > MAX_SLICEABLE_PDF_BYTES) {
		return { ok: false, reason: 'too_large' };
	}

	const file = await env.R2_BUCKET.get(key);
	if (!file) return { ok: false, reason: 'no_source' };
	return slicePdfPage(new Uint8Array(await file.arrayBuffer()), ref.page_no);
}

export async function slicePdfPage(
	pdf: Uint8Array,
	pageNo: number
): Promise<PageView> {
	const source = await PDFDocument.load(pdf, { ignoreEncryption: true });
	if (pageNo < 1 || pageNo > source.getPageCount()) {
		return { ok: false, reason: 'no_such_page' };
	}
	const single = await PDFDocument.create();
	const [page] = await single.copyPages(source, [pageNo - 1]);
	single.addPage(page);
	return {
		ok: true,
		media_type: 'application/pdf',
		data: await single.save(),
	};
}
