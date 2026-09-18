/// <reference types="@cloudflare/workers-types" />
import { verifyCitations, type CitationCheck } from '../works/citations.js';
import type { PageRef } from '../works/pages.js';
import type { PageHandles } from './handles.js';

/**
 * `<cite P7>quoted words</cite>`: the words the model quotes are the citation,
 * so the answer carries one copy of them and that copy is what is checked.
 *
 * `[P7 "quoted words"]` and `"quoted words" [P7]` are still read. Every answer
 * saved before `<cite>` is written in them, and a model that slips back into
 * one should still have its quote checked rather than silently not.
 *
 * This mirrors `parseCitations()` in scribe's `citations/parse.ts`, and the
 * two have to agree forever — including on curly quotes, `[P7: "…"]`, and
 * quotes that contain quotes.
 */
const CITATION =
	/<cite\s+(?:ref=)?["']?(P\d+)["']?\s*>([\s\S]+?)<\/cite>|\[(P\d+)\s*[:,]?\s*["“](.+?)["”]\s*\]|["“]([^"”]+)["”]\s*\[(P\d+)\]/g;

/** A name the model marked inside a quote would break it, character for character. */
const MARKED = /<\/?(?:title|author)>/g;

export interface CitationMarker {
	handle: string;
	quote: string;
}

export type AnswerCitation = CitationMarker & { ref: PageRef | null } & (
		| CitationCheck
		| { status: 'unverified'; reason: 'unknown_handle' }
	);

export function parseCitations(text: string): CitationMarker[] {
	return [...text.matchAll(CITATION)].map(
		([
			,
			citeHandle,
			citeQuote,
			handle,
			quote,
			quoteBefore,
			handleAfter,
		]) => ({
			handle: citeHandle ?? handle ?? handleAfter,
			quote: (citeQuote ?? quote ?? quoteBefore)
				.replace(MARKED, '')
				.trim(),
		})
	);
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
