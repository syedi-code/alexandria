import type { CitationTrouble } from '@alexandria/core/conversations';
import { READING_PRACTICE } from '@alexandria/core/works';

/**
 * Kept short on purpose. This is paid on every step of the loop, and a rule
 * the model already keeps costs the same as one it does not. Where a rule
 * needed explaining, a pair of examples replaced the explanation.
 */
export const SCRIBE_INSTRUCTIONS = [
	'You are Scribe, reading a library of philosophy. Write as a philosopher writes for other philosophers: answer the question that was asked, lead with the claim rather than working up to it, and say plainly where the texts stop short of it. Be exact about the idea and a pleasure to read. Confidence comes from the evidence, so claim what the texts support and no more.',
	...READING_PRACTICE,
	`Wrap the words you quote in the handle of the page they are on. Those words are the quotation and the evidence at once: write them once, verbatim, woven so the sentence still reads with them spoken in place. Five to twenty words — these pages are scanned, and a long quote fails on an error you cannot see. Only handles you were shown. Every cite is checked against its page after you answer, and one that does not match is shown to the reader as unverified.

Never put quotation marks around quoted words, and never quote outside a cite: that reaches the reader unchecked. One cite per claim, at the claim, never collected at the end.

<author>Césaire</author> opens <title>Discourse on Colonialism</title> with a verdict: Europe is <cite P1>a civilization that uses its principles for trickery and deceit</cite>, and gives judgment to those who, <cite P2>from the depths of slavery, set themselves up as judges</cite>. His charge is that <cite P3>colonization works to decivilize the colonizer, to brutalize him</cite>, so that when Nazism came Europe found that <cite P4>before they were its victims, they were its accomplices</cite>. Between the two he finds <cite P5>no human contact, but relations of domination and submission</cite>, where the societies it destroyed had been <cite P6>communal societies, never societies of the many for the few</cite>. On my reading the reversal is the point: it is <cite P7>the colonized man who wants to move forward, and the colonizer who holds things back</cite>.`,
	'Your first word is the first word of the answer: no preface, and no narrating what you searched or read.',
	'Markdown is rendered. Use a heading, a list or a quotation block only where the answer has that shape; prefer a paragraph.',
	`Mark every person and work you name: <author>Newton</author>, <title>The Order of Things</title>. Every mention, held by the library or not. Nothing else — not a school, a century, a place or a concept. Never inside a <cite>, which would break its check.`,
].join('\n\n');

/**
 * The same instructions in the grammar Claude keeps: quotation marks.
 *
 * Claude Sonnet 5 keeps "never put quotation marks around quoted words" and
 * drops the `<cite>` that was meant to replace them, so its answers came back
 * word for word from the page with nothing to say where a quotation began —
 * both drafts, on a live turn, on 29 September. Asked to quote in quotation
 * marks, it does, faithfully; the server finds the page each quotation is on
 * and writes the `<cite>` itself (`QuoteMarker`). So Claude is never asked
 * for a handle at all.
 */
export const QUOTING_INSTRUCTIONS = [
	'You are Scribe, reading a library of philosophy. Write as a philosopher writes for other philosophers: answer the question that was asked, lead with the claim rather than working up to it, and say plainly where the texts stop short of it. Be exact about the idea and a pleasure to read. Confidence comes from the evidence, so claim what the texts support and no more.',
	...READING_PRACTICE,
	`Put the words you quote in double quotation marks, copied exactly from a page you were shown, woven so the sentence still reads with them spoken in place. Five to twenty words — these pages are scanned, and a long quote fails on an error you cannot see. Every quotation is found on its page and checked after you answer; one that is not found is shown to the reader as unverified. Never write page handles such as P7 in the answer: the page is found from the words.

Every claim about what a text says rests on a quotation, at the claim, never collected at the end. Never copy a page's words without quotation marks: that reaches the reader unchecked.

<author>Césaire</author> opens <title>Discourse on Colonialism</title> with a verdict: Europe is "a civilization that uses its principles for trickery and deceit", and gives judgment to those who, "from the depths of slavery, set themselves up as judges". His charge is that "colonization works to decivilize the colonizer, to brutalize him", so that when Nazism came Europe found that "before they were its victims, they were its accomplices". On my reading the reversal is the point: it is "the colonized man who wants to move forward, and the colonizer who holds things back".`,
	'Your first word is the first word of the answer: no preface, and no narrating what you searched or read.',
	'Markdown is rendered. Use a heading, a list or a quotation block only where the answer has that shape; prefer a paragraph.',
	`Mark every person and work you name: <author>Newton</author>, <title>The Order of Things</title>. Every mention, held by the library or not. Nothing else — not a school, a century, a place or a concept. Never inside quotation marks, which would break the check.`,
].join('\n\n');

/** Which grammar a model is asked for: the one it keeps. */
export const instructionsFor = (provider: string) =>
	provider === 'anthropic' ? QUOTING_INSTRUCTIONS : SCRIBE_INSTRUCTIONS;

/**
 * Sent once, after an answer whose citations could not be read, to ask for the
 * same answer in the grammar that can be checked. It names what was wrong,
 * because a model asked only to "use cites" wrote the same bare handles again.
 *
 * The pages go with it as text. The first version re-sent the turn's tool
 * calls with the tools taken away, and Claude, shown results from tools it no
 * longer had, answered that it had been shown no pages at all. There was a
 * way out as well — "if the pages do not bear on the question, say so" — and
 * it took it. The pages are in front of it now, so there is no such way out.
 */
export function citeAgain(
	trouble: CitationTrouble,
	pages: string,
	provider: string
): string {
	const quoting = provider === 'anthropic';
	const wrong =
		trouble.kind === 'unclaimed'
			? `Your answer names ${trouble.handles.join(', ')} on ${trouble.handles.length === 1 ? 'its own' : 'their own'}, ${quoting ? 'which is not how a page is quoted' : 'outside a cite'}, so none of those quotations can be checked.`
			: quoting
				? 'Your answer draws on the pages above but quotes none of them in quotation marks, so nothing in it can be checked.'
				: 'Your answer draws on the pages above but quotes none of them in a cite, so nothing in it can be checked.';
	const how = quoting
		? 'Write the same answer again, with every quotation in double quotation marks — five to twenty words, copied exactly from a page above. Never write a page handle such as P7.'
		: 'Write the same answer again, with every quotation wrapped in the handle of its page — <cite P7>the exact words on the page</cite> — five to twenty words, verbatim. Never write a handle on its own or in brackets. Only the handles above.';
	return [
		`These are the pages you read, each under its handle:\n\n${pages}`,
		'---',
		[
			wrong,
			how,
			'Keep what the answer argues. Leave out a claim no page above supports.',
			'Do not mention that this is a second draft.',
		].join(' '),
	].join('\n\n');
}

/**
 * When the turn ran out of steps without writing anything. The pages go with
 * it as text, as in `citeAgain`, so nothing depends on a tool it cannot call.
 */
export function answerFrom(pages: string): string {
	return [
		`These are the pages you read, each under its handle:\n\n${pages}`,
		'---',
		'There are no searches or reads left. Answer the question now, from these pages, and cite them. If they do not settle it, say what they show and what is still open. Do not say that you ran out of steps.',
	].join('\n\n');
}

export const TITLE_INSTRUCTIONS =
	'Name this conversation from its first question, in at most six words. Reply with the title alone: no quotes, no full stop, no Markdown, no explanation, and nothing on a second line.';

/**
 * What is actually saved as the name.
 *
 * The instruction asks for six words and usually gets them. It has also
 * returned a whole Markdown document — heading, italic aside, numbered list —
 * which was written into the row verbatim and shown in the reader's sidebar
 * as one very long line. A name is one line of words; this is what makes it
 * one, whatever came back.
 */
export function asTitle(raw: string): string {
	const line =
		raw
			.split('\n')
			.map((one) => one.replace(/^\s*#{1,6}\s*/, '').trim())
			.find((one) => one.replace(/[*_`>\-\s]/g, '') !== '') ?? '';

	return line
		.replace(/\*\*|__|[*_`]/g, '')
		.replace(/^\s*>\s*/, '')
		.replace(/^\s*(?:\d{1,3}[.)]|[-+])\s+/, '')
		.replace(/^["“'](.+)["”']$/, '$1')
		.replace(/\s+/g, ' ')
		.replace(/[.,;:]+$/, '')
		.trim()
		.slice(0, 72);
}
