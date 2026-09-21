import { describe, it, expect } from 'vitest';
import {
	collapseQuotedDuplicates,
	normaliseCitationShapes,
	parseCitations,
} from '../conversations/index.js';

/**
 * The model leaving the citation grammar altogether.
 *
 * On 20 September a heavy turn came back with no citations at all, because
 * every one of them was written in OpenAI's file-search notation rather than
 * in ours. Nothing parsed, nothing was verified, and the reader was shown the
 * brackets. The handles and the quoted words were right the whole time.
 */
describe('a citation in a foreign notation', () => {
	const foreign =
		'She cites him on death and inorganic matter【P5†Inorganic matter is the maternal bosom】.';

	it('is read as the citation it is', () => {
		expect(parseCitations(foreign)).toEqual([]);
		expect(parseCitations(normaliseCitationShapes(foreign))).toEqual([
			{
				handle: 'P5',
				quote: 'Inorganic matter is the maternal bosom',
			},
		]);
	});

	// The marker hangs off the word the way a footnote number does. A
	// quotation does not, so the space its notation never needed is part of
	// the translation.
	it('is written in our own notation, spaced as a quotation', () => {
		expect(normaliseCitationShapes(foreign)).toBe(
			'She cites him on death and inorganic matter <cite P5>Inorganic matter is the maternal bosom</cite>.'
		);
	});

	// Production wrote nine correct cites and two foreign ones in one answer.
	// The nine must survive untouched.
	it('is translated beside citations that were already right', () => {
		const mixed =
			'One <cite P3>the dream is a wish-fulfilment</cite> and two【P7†The warrior loves danger and sport】.';
		expect(
			parseCitations(normaliseCitationShapes(mixed)).map((c) => c.handle)
		).toEqual(['P3', 'P7']);
	});

	// Only a handle this app minted. Anything else is not ours to rewrite, and
	// a turn that still carries one is a turn that failed to cite.
	it('leaves a marker that names no handle of ours', () => {
		const alien = 'A reference【4:2†source.pdf】 here.';
		expect(normaliseCitationShapes(alien)).toBe(alien);
	});

	it('leaves an answer that was written correctly', () => {
		const fine =
			'Europe is <cite P1>a civilization that uses its principles for trickery</cite>.';
		expect(normaliseCitationShapes(fine)).toBe(fine);
	});

	// The two passes meet: a quotation written out and then cited in the
	// foreign shape is still one quotation written twice.
	it('is collapsed when the words were also written out in the prose', () => {
		const both =
			'He says “the dream is a wish-fulfilment” 【P3†the dream is a wish-fulfilment】.';
		expect(collapseQuotedDuplicates(normaliseCitationShapes(both))).toBe(
			'He says <cite P3>the dream is a wish-fulfilment</cite>.'
		);
	});
});
