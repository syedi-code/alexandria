import { describe, it, expect } from 'vitest';
import {
	citationTrouble,
	PageHandles,
	unclaimedHandles,
} from '../conversations/index.js';

/**
 * A citation written in a shape that cannot be read.
 *
 * On 22 September Claude Sonnet 5 answered with its quotations unmarked in the
 * prose and a bare handle after each one. Nothing parsed and nothing was
 * checked, and the reader was shown what looked like a fully cited answer.
 * These are its sentences, verbatim.
 */
const bare =
	'he suspects that for a philosopher every cave does not have, must not have, an even deeper cave behind it, so that what looks like a foundation is only another surface, and there is an abyss behind every ground, under every groundwork (P14). Every philosophy, on this hermit’s judgment, is a foreground philosophy.';

/** A turn that was given `count` handles, P1 upwards. */
const minted = (count: number) => {
	const handles = new PageHandles();
	for (let page = 1; page <= count; page++)
		handles.handleFor({ document_id: 'd', page_no: page });
	return handles;
};

describe('a handle no citation claimed', () => {
	const known = (handle: string) => ['P14', 'P23'].includes(handle);

	it('is found in the shape production wrote', () => {
		expect(unclaimedHandles(bare, known)).toEqual(['P14']);
	});

	it('is not found when every handle is inside a citation', () => {
		expect(
			unclaimedHandles(
				'He finds <cite P14>an abyss behind every ground</cite>, and a <cite P23>mask</cite> [P14 "under every groundwork"].',
				known
			)
		).toEqual([]);
	});

	it('is found beside a citation that did parse', () => {
		expect(
			unclaimedHandles(
				'He finds <cite P14>an abyss behind every ground</cite>; every profound spirit needs a mask (P23).',
				known
			)
		).toEqual(['P23']);
	});

	it('is read inside a foreign shape that carries its words', () => {
		expect(
			unclaimedHandles(
				'He finds it【P14†an abyss behind every ground】.',
				known
			)
		).toEqual([]);
	});

	it('is only a handle this turn was given', () => {
		expect(
			unclaimedHandles('Tumour suppressor P53 and P14 appear.', known)
		).toEqual(['P14']);
	});

	it('is named once however often it is written', () => {
		expect(unclaimedHandles('a (P14), b (P14), c [P14].', known)).toEqual([
			'P14',
		]);
	});
});

describe('what is wrong with an answer', () => {
	it('is its unclaimed handles', () => {
		const handles = minted(14);
		expect(citationTrouble(bare, handles, true)).toEqual({
			kind: 'unclaimed',
			handles: ['P14'],
		});
	});

	// The first Claude answer: it read four pages and paraphrased them.
	it('is that it read pages and cited none of them', () => {
		expect(
			citationTrouble(
				'whoever fights with monsters should see to it that he does not become one himself.',
				minted(1),
				true
			)
		).toEqual({ kind: 'uncited' });
	});

	it('is nothing when it read nothing and cited nothing', () => {
		expect(
			citationTrouble('The library holds no Spinoza.', minted(0), false)
		).toBeNull();
	});

	it('is nothing when its citations can be read', () => {
		expect(
			citationTrouble(
				'He warns <cite P1>he who fights with monsters</cite>.',
				minted(1),
				true
			)
		).toBeNull();
	});

	it('is nothing when there is no answer to check', () => {
		expect(citationTrouble('  ', minted(1), true)).toBeNull();
	});
});
