/// <reference types="@cloudflare/workers-types" />
import { getPages, type PageRef, type PageText } from './pages.js';

export type CitationCheck =
	| { status: 'verified'; matched: PageRef[] }
	| {
			status: 'unverified';
			reason:
				| 'not_found'
				| 'partial_match'
				| 'quote_too_short'
				| 'no_such_page';
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
 * hyphenation.
 *
 * A hyphen between letters is ambiguous. Joined, `self- deception` (a line
 * break) and `self-deception` are the same word; but a dash that extraction
 * turned into a hyphen, `rationalism-their`, needs splitting instead. Quotes
 * are checked both ways.
 */
export function normalizeForMatching(
	text: string,
	hyphens: 'join' | 'split' = 'join'
): string {
	return text
		.toLowerCase()
		.replace(/[œæß]/g, (ligature) => LIGATURES[ligature])
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.replace(/\u00AD/g, '')
		.replace(
			/(\p{L})[-‐‑]\s*(\p{L})/gu,
			hyphens === 'join' ? '$1$2' : '$1 $2'
		)
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

/** Scholarly quotation leaves words out: `each of these gentlemen... claims that`. */
const ELLIPSIS = /(?:\s*\.){3}|…/;

/** A fragment between ellipses shorter than this matches too much text to count. */
const MIN_ELIDED_PART_WORDS = 3;

const wordCount = (normalized: string) =>
	normalized.split(' ').filter(Boolean).length;

/** Whether the quote is on the page — or, if it elides words, each part of it, in order. */
function contains(haystack: string, quote: string): boolean {
	for (const hyphens of ['join', 'split'] as const) {
		const page = ` ${normalizeForMatching(haystack, hyphens)} `;
		if (page.includes(` ${normalizeForMatching(quote, hyphens)} `)) {
			return true;
		}

		const parts = quote
			.split(ELLIPSIS)
			.map((part) => normalizeForMatching(part, hyphens))
			.filter(Boolean);
		if (
			parts.length < 2 ||
			parts.some((part) => wordCount(part) < MIN_ELIDED_PART_WORDS)
		) {
			continue;
		}
		let from = 0;
		const inOrder = parts.every((part) => {
			const at = page.indexOf(` ${part} `, from);
			from = at + part.length + 1;
			return at !== -1;
		});
		if (inOrder) return true;
	}
	return false;
}

/**
 * Whether the quote begins on the page, when the whole of it is not there.
 *
 * It says where to look, not who is at fault. A long quote copied faithfully
 * diverges when it runs through a word the scan mangled — "forms" arriving as
 * "lOrms" — and a misquote diverges at the word the model got wrong. Both are
 * unverified; both are worth distinguishing from a quote the page does not
 * support at all.
 */
function beginsOn(haystack: string, quote: string): boolean {
	const page = ` ${normalizeForMatching(haystack, 'split')} `;
	const words = normalizeForMatching(quote, 'split').split(' ');
	return (
		words.length > MIN_QUOTE_WORDS &&
		page.includes(` ${words.slice(0, MIN_QUOTE_WORDS).join(' ')} `)
	);
}

export function checkQuote(
	quote: string,
	page: PageText | undefined,
	next?: PageText
): CitationCheck {
	if (!page) return { status: 'unverified', reason: 'no_such_page' };
	if (page.text === null) {
		return { status: 'unverifiable', reason: 'no_text_layer' };
	}

	if (wordCount(normalizeForMatching(quote)) < MIN_QUOTE_WORDS) {
		return { status: 'unverified', reason: 'quote_too_short' };
	}

	if (contains(page.text, quote)) {
		return { status: 'verified', matched: [page.ref] };
	}
	if (next?.text && contains(acrossPageBreak(page.text, next.text), quote)) {
		return { status: 'verified', matched: [page.ref, next.ref] };
	}

	const haystack = next?.text
		? acrossPageBreak(page.text, next.text)
		: page.text;
	return {
		status: 'unverified',
		reason: beginsOn(haystack, quote) ? 'partial_match' : 'not_found',
	};
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
