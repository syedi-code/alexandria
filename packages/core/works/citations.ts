/// <reference types="@cloudflare/workers-types" />
import { getPages, type PageRef, type PageText } from './pages.js';

export type CitationCheck =
	| { status: 'verified'; matched: PageRef[] }
	| {
			status: 'unverified';
			reason: 'not_found' | 'quote_too_short' | 'no_such_page';
	  }
	| { status: 'unverifiable'; reason: 'no_text_layer' };

export type CitationStatus = CitationCheck['status'];

/** Below this, a quote matches too much text by accident to count as evidence. */
export const MIN_QUOTE_WORDS = 5;

/** NFKD folds ﬁ-style ligatures, but not these. */
const LIGATURES: Record<string, string> = { œ: 'oe', æ: 'ae', ß: 'ss' };

/**
 * Reduces text to lowercase words, so a quote matches its page whatever the
 * PDF did to diacritics, ligatures, quote marks, dashes, line breaks and
 * hyphenation. Hyphens are removed rather than spaced, which makes
 * `self- deception` (a line break) and `self-deception` the same word.
 */
export function normalizeForMatching(text: string): string {
	return text
		.toLowerCase()
		.replace(/[œæß]/g, (ligature) => LIGATURES[ligature])
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.replace(/\u00AD/g, '')
		.replace(/(\p{L})[-‐‑]\s*(\p{L})/gu, '$1$2')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/** Running headers, folios and letter-spaced titles that sit between the end of one page and the start of the next. */
const PAGE_FURNITURE =
	/^\s*(\d{1,4}|[ivxlcdm]{1,6}|[IVXLCDM]{1,6}|(?:\p{Lu}\s){3,}[\p{Lu}\d\s]*|.{0,60}\s\d{1,4})\s*$/u;

function stripFurniture(lines: string[]): string[] {
	const kept = [...lines];
	while (kept.length && PAGE_FURNITURE.test(kept[0])) kept.shift();
	while (kept.length && PAGE_FURNITURE.test(kept[kept.length - 1]))
		kept.pop();
	return kept;
}

/** The end of one page joined to the start of the next, for quotes that cross the break. */
function acrossPageBreak(page: string, next: string): string {
	return [
		...stripFurniture(page.split('\n')),
		...stripFurniture(next.split('\n')),
	].join('\n');
}

const contains = (haystack: string, needle: string) =>
	` ${normalizeForMatching(haystack)} `.includes(` ${needle} `);

export function checkQuote(
	quote: string,
	page: PageText | undefined,
	next?: PageText
): CitationCheck {
	if (!page) return { status: 'unverified', reason: 'no_such_page' };
	if (page.text === null) {
		return { status: 'unverifiable', reason: 'no_text_layer' };
	}

	const needle = normalizeForMatching(quote);
	if (needle.split(' ').filter(Boolean).length < MIN_QUOTE_WORDS) {
		return { status: 'unverified', reason: 'quote_too_short' };
	}

	if (contains(page.text, needle)) {
		return { status: 'verified', matched: [page.ref] };
	}
	if (next?.text && contains(acrossPageBreak(page.text, next.text), needle)) {
		return { status: 'verified', matched: [page.ref, next.ref] };
	}
	return { status: 'unverified', reason: 'not_found' };
}

export interface CitationInput {
	ref: PageRef;
	quote: string;
}

/** Checks many citations with one page query per document. */
export async function verifyCitations(
	db: D1Database,
	citations: readonly CitationInput[]
): Promise<CitationCheck[]> {
	const pageNosByDocument = new Map<string, number[]>();
	for (const { ref } of citations) {
		const pageNos = pageNosByDocument.get(ref.document_id) ?? [];
		pageNos.push(ref.page_no, ref.page_no + 1);
		pageNosByDocument.set(ref.document_id, pageNos);
	}

	const pages = new Map<string, PageText>();
	const key = (ref: PageRef) => `${ref.document_id}#${ref.page_no}`;
	for (const [documentId, pageNos] of pageNosByDocument) {
		for (const page of await getPages(db, documentId, pageNos)) {
			pages.set(key(page.ref), page);
		}
	}

	return citations.map(({ ref, quote }) =>
		checkQuote(
			quote,
			pages.get(key(ref)),
			pages.get(key({ ...ref, page_no: ref.page_no + 1 }))
		)
	);
}

export async function verifyCitation(
	db: D1Database,
	citation: CitationInput
): Promise<CitationCheck> {
	const [check] = await verifyCitations(db, [citation]);
	return check;
}
