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
 * verdict. It arrived that way on 29 of 137 citations, and the rate did not
 * move when the citation syntax changed under it, because the syntax was
 * never what it was doing wrong.
 *
 * Nor can another revision of the instruction be shown to work. The mode
 * fires on about one answer in three, holds for a whole answer once it
 * starts, and did not fire once across twelve replays of the exact context
 * that produced it — so no affordable number of samples tells a fixed prompt
 * from a lucky one. It is taken out here instead.
 *
 * What counts as the same quotation twice is the words, not the marks around
 * them: if the prose immediately before a citation ends with the words that
 * citation quotes, that is one quotation written twice. Every instance in
 * production was a quoted run and a single space, but the rule is not pinned
 * to that — the instructions already tell the model not to put quotation
 * marks around quoted words, so the day it keeps that half of the rule and
 * still writes the words twice, a rule that looked for quotation marks would
 * go blind.
 *
 * Only the run against the citation is collapsed. A quotation that appears
 * again elsewhere in the answer is the answer re-reading it and is left
 * alone: pairing quotations with distant citations by their shared words is
 * what scribe's `anchorsFor()` did, and it paired 42 of 92. Below five words
 * nothing is collapsed, because a short run repeats innocently.
 */
const WORD = /[\p{L}\p{N}]/u;
/** What the copy was opened with, left behind once its closer has gone. */
const OPENER = /[*_"“([]/;
const MIN_REPEATED_WORDS = 5;
/** Marks and tags the written-out copy may carry that the cited one does not. */
const COPY_SLACK = 40;

const wordsOf = (text: string) =>
	text
		.replace(MARKED, '')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.toLowerCase()
		.split(' ')
		.filter(Boolean);

/** How much of the end of `head` is the citation's words, written out again. */
function repeatedTail(head: string, quote: string): number {
	const wanted = wordsOf(quote);
	if (wanted.length < MIN_REPEATED_WORDS) return 0;
	const target = wanted.join(' ');
	const longest = Math.min(head.length, quote.length + COPY_SLACK);

	// Shortest first: the least that can come out is the copy itself.
	for (let take = target.length; take <= longest; take++) {
		const at = head.length - take;
		// Never start inside a word, or `breathe` gives up a `the`.
		if (at > 0 && WORD.test(head[at - 1])) continue;
		const tail = wordsOf(head.slice(at));
		if (tail.length !== wanted.length || tail.join(' ') !== target)
			continue;

		// The marks the copy was opened with go too: an italic whose closing
		// mark has just been taken out would show the reader a stray `*`.
		let from = at;
		while (from > 0 && OPENER.test(head[from - 1])) from--;
		return head.length - from;
	}

	return 0;
}

export function collapseQuotedDuplicates(text: string): string {
	let out = '';
	let cursor = 0;

	for (const match of text.matchAll(CITATION)) {
		// Only as far back as the citation before it, so a run can never be
		// claimed by two citations.
		const head = text.slice(cursor, match.index);
		const quote = match[2] ?? match[4] ?? match[5];
		const take = repeatedTail(head, quote);
		out += take > 0 ? head.slice(0, head.length - take) : head;
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
