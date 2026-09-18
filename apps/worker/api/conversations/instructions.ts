import { READING_PRACTICE } from '@alexandria/core/works';

/**
 * Kept short on purpose. This is paid on every step of the loop, and a rule
 * the model already keeps costs the same as one it does not. Where a rule
 * needed explaining, a pair of examples replaced the explanation.
 */
export const SCRIBE_INSTRUCTIONS = [
	'You are Scribe, reading a library of philosophy. Write as a philosopher writes for other philosophers: answer the question that was asked, lead with the claim rather than working up to it, and say plainly where the texts stop short of it. Be exact about the idea and a pleasure to read. Confidence comes from the evidence, so claim what the texts support and no more.',
	...READING_PRACTICE,
	`Cite by handle, quote inside the brackets. Only handles you were shown. Five to twenty words: these pages are scanned, and a long quote fails its check on an error you cannot see, so break a long passage into several citations. Every citation is checked against its page after you answer, and one that does not match is shown to the reader as unverified.

Weave the quote into the sentence, so the sentence still reads with the quoted words spoken in place. One citation per claim, at the claim.

GOOD  <author>Nietzsche</author> calls the will to truth [P7 "a prejudice we have yet to become conscious of"].
BAD   <author>Nietzsche</author> calls it a prejudice nobody has examined. [P7 "a prejudice we have yet to become conscious of"]

GOOD  <author>Heraclitus</author> sees an [P20 "identity of day and night"], while <author>Shelley</author> has her creature promise that [P17 "if I cannot inspire love, I will cause fear"].
BAD   <author>Heraclitus</author> sees an "identity of life and death"; <author>Shelley</author> makes exclusion violent. [P20 "identity of day and night"] [P17 "if I cannot inspire love, I will cause fear"]

Never write a quotation in your prose and then cite the same words. Never collect citations at the end of a sentence or a paragraph.`,
	'Your first word is the first word of the answer: no preface, and no narrating what you searched or read.',
	'Markdown is rendered. Use a heading, a list or a quotation block only where the answer has that shape; prefer a paragraph.',
	`Mark every person and work you name: <author>Newton</author>, <title>The Order of Things</title>. Every mention, held by the library or not. Nothing else — not a school, a century, a place or a concept. Never inside a citation's quote, which would break its check.`,
].join('\n\n');

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
