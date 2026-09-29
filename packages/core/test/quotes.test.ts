import { describe, expect, it } from 'vitest';
import { PageShelf, QuoteMarker } from '../conversations/quotes.js';

/**
 * On 29 September Claude Sonnet 5 quoted a handbook word for word in plain
 * quotation marks, cited nothing, and was asked again — and the second pass
 * said it had read no pages at all. A quotation that is on a page the model
 * was shown is marked as a citation of that page, as it streams.
 */

const ref = { document_id: 'd1', page_no: 9 };

function shelf() {
	const pages = new PageShelf();
	pages.addFrom([
		{
			handle: 'P1',
			ref,
			work_title: 'On the Use and Abuse of History',
			creator: 'Friedrich Nietzsche',
			printed_page: '9',
			text: 'It will always bring closer what is unlike, gener-\nalize, and finally make things equal.',
		},
		{
			handle: 'P2',
			ref: { ...ref, page_no: 10 },
			snippet:
				'…he will empower himself through «monumental history». On the…',
		},
	]);
	return pages;
}

const marked = (...deltas: string[]) => {
	const marker = new QuoteMarker(shelf());
	const out =
		deltas.map((delta) => marker.push(delta)).join('') + marker.flush();
	return { out, marker };
};

describe('a quotation in quotation marks', () => {
	it('is marked as a citation of the page it is on', () => {
		const { out, marker } = marked(
			'History, he says, “will always bring closer what is unlike,” and so on.'
		);
		expect(out).toBe(
			'History, he says, <cite P1>will always bring closer what is unlike</cite>, and so on.'
		);
		expect(marker.marked).toBe(1);
	});

	it('is found across a hyphenated line break, as the verifier finds it', () => {
		expect(
			marked('“unlike, generalize, and finally make things equal”').out
		).toBe(
			'<cite P1>unlike, generalize, and finally make things equal</cite>'
		);
	});

	it('is found in a search snippet, without its highlighting', () => {
		expect(
			marked('he "will empower himself through monumental history"').out
		).toBe(
			'he <cite P2>will empower himself through monumental history</cite>'
		);
	});

	it('is found however the stream splits it', () => {
		expect(
			marked(
				'He wrote “will always',
				' bring closer what',
				' is unlike” once.'
			).out
		).toBe(
			'He wrote <cite P1>will always bring closer what is unlike</cite> once.'
		);
	});

	it('is left alone, and counted, when no page holds it', () => {
		const { out, marker } = marked(
			'He never wrote “the will to power is all there is.”'
		);
		expect(out).toBe('He never wrote “the will to power is all there is.”');
		expect(marker.unmarked).toBe(1);
	});

	it('is left alone under five words, which is too short to be evidence', () => {
		const { out, marker } = marked('“make things equal” is the phrase.');
		expect(out).toBe('“make things equal” is the phrase.');
		expect(marker.unmarked).toBe(0);
	});
});

describe('what is not a quotation to mark', () => {
	it('is a citation the model wrote itself, even split mid-tag', () => {
		expect(
			marked(
				'As <ci',
				'te P1>“will always bring closer what is unlike”</cite> says.'
			).out
		).toBe(
			'As <cite P1>“will always bring closer what is unlike”</cite> says.'
		);
	});

	it('is an inch mark or a quotation mark that never closes', () => {
		expect(
			marked('A 12" record, then a "stray mark\n\nand a new paragraph.')
				.out
		).toBe('A 12" record, then a "stray mark\n\nand a new paragraph.');
	});

	it('is a quotation already cited in the older grammar, on either side', () => {
		const before =
			'[P1 "will always bring closer what is unlike"] and more';
		const after = '“will always bring closer what is unlike” [P1] and more';
		expect(marked(before).out).toBe(before);
		expect(marked(after).out).toBe(after);
		// The handle after it may arrive in a later piece of the stream.
		expect(
			marked(
				'“will always bring closer what is unlike” [',
				'P1] and more'
			).out
		).toBe(after);
	});

	it('is a quotation holding marked names', () => {
		const text =
			'“<title>History</title> will always bring closer what is unlike”';
		expect(marked(text).out).toBe(text);
	});
});

describe('the pages, rendered to write from', () => {
	it('carry their handles and where they are', () => {
		const text = shelf().render();
		expect(text).toContain(
			'[P1] On the Use and Abuse of History — Friedrich Nietzsche — p. 9 (PDF p. 9)'
		);
		expect(text).toContain('[P2]\n…he will empower himself');
	});

	it('keep a whole page over a snippet of it', () => {
		const pages = shelf();
		pages.addFrom({ handle: 'P2', text: 'short' });
		expect(pages.render()).toContain('empower');
	});
});
