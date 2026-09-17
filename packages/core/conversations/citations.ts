/// <reference types="@cloudflare/workers-types" />
import { verifyCitations, type CitationCheck } from '../works/citations.js';
import type { PageRef } from '../works/pages.js';
import type { PageHandles } from './handles.js';

/**
 * `[P7 "quoted words"]`. Curly quotes are accepted because models produce
 * them; a colon or comma after the handle is tolerated for the same reason.
 */
const CITATION = /\[(P\d+)\s*[:,]?\s*["“]([^"”\]]+)["”]\s*\]/g;

export interface CitationMarker {
	handle: string;
	quote: string;
}

export type AnswerCitation = CitationMarker & { ref: PageRef | null } & (
		| CitationCheck
		| { status: 'unverified'; reason: 'unknown_handle' }
	);

export function parseCitations(text: string): CitationMarker[] {
	return [...text.matchAll(CITATION)].map(([, handle, quote]) => ({
		handle,
		quote: quote.trim(),
	}));
}

/** Every citation in an answer, checked against the page its handle names. */
export async function verifyAnswer(
	db: D1Database,
	handles: PageHandles,
	text: string
): Promise<AnswerCitation[]> {
	const markers = parseCitations(text).map((marker) => ({
		...marker,
		ref: handles.resolve(marker.handle) ?? null,
	}));

	const checks = await verifyCitations(
		db,
		markers.flatMap(({ ref, quote }) => (ref ? [{ ref, quote }] : []))
	);

	let next = 0;
	return markers.map(
		(marker): AnswerCitation =>
			marker.ref
				? { ...marker, ...checks[next++] }
				: { ...marker, status: 'unverified', reason: 'unknown_handle' }
	);
}
