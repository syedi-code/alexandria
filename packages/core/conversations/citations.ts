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

/**
 * A quotation the model wrote out twice.
 *
 * The instructions ask for the quoted words to be written once, inside the
 * cite. Across production the model wrote them twice instead — the quotation
 * in its prose, then the same words again in the citation — and the reader was
 * shown the passage back to back with itself, the second copy carrying the
 * verdict. It is the shape the model falls into, not a format it was ever
 * offered: 29 of 137 answers' citations arrived this way, and the rate did not
 * move when the citation syntax changed under it. Three revisions of the
 * instruction have failed to stop it, and a fourth is not falsifiable — the
 * mode fires on roughly one answer in three and never on demand, so no
 * affordable number of samples tells a fixed prompt from a lucky one.
 *
 * So it is taken out here rather than asked about. Every instance in
 * production is the same shape: a quoted run, one space, then a citation of
 * the same words. That is the only thing collapsed. A quotation that merely
 * appears again later in the answer is a reader's own re-reading of it and is
 * left alone — pairing quotations with distant citations by their words is
 * what `anchorsFor()` did in scribe, and it paired 42 of 92.
 *
 * Punctuation is folded before the two copies are compared, because the model
 * has written `…from a Greek?` in the prose and `…from a Greek!` in the cite.
 * Whole runs of five words and more are being compared, so folding it cannot
 * bring two different quotations together.
 */
const DUPLICATED_RUN = /(["“])([^"”\n]{2,300})(["”]) $/;

const sameWords = (a: string, b: string) => {
	const fold = (text: string) =>
		text
			.replace(MARKED, '')
			.replace(/[^\p{L}\p{N}]+/gu, ' ')
			.trim()
			.toLowerCase();
	return fold(a) === fold(b);
};

export function collapseQuotedDuplicates(text: string): string {
	let out = '';
	let cursor = 0;

	for (const match of text.matchAll(CITATION)) {
		// Only as far back as the citation before it, so a run can never be
		// claimed by two citations.
		const head = text.slice(cursor, match.index);
		const quote = match[2] ?? match[4] ?? match[5];
		const run = DUPLICATED_RUN.exec(head);
		out +=
			run && sameWords(run[2], quote)
				? head.slice(0, head.length - run[0].length)
				: head;
		out += match[0];
		cursor = match.index + match[0].length;
	}

	return out + text.slice(cursor);
}

/** An answer with every quotation written once, wherever its text is held. */
export function withCollapsedQuotes<M extends { parts: readonly unknown[] }>(
	message: M
): M {
	return {
		...message,
		parts: message.parts.map((part) => {
			const { type, text } = part as { type?: string; text?: string };
			return type === 'text' && text
				? { ...(part as object), text: collapseQuotedDuplicates(text) }
				: part;
		}),
	};
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
