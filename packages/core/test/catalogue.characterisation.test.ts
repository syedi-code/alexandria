import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TestDatabase } from './d1.js';
import { catalogueTestDatabase, ids } from './fixture.js';
import { getLibraryBooks, getBookDetail } from '../writing/enrichment.js';
import { deriveLibraryDecade } from '../works/catalogue.js';

let db: TestDatabase;

beforeEach(() => {
	db = catalogueTestDatabase();
});

afterEach(() => db.close());

describe('deriveLibraryDecade', () => {
	it.each([
		[null, 'unknown'],
		['', 'unknown'],
		['1886', 'pre-1900'],
		['1947', '1900s'],
		['2005', '2000s'],
		['2015', '2010s'],
		['2021', '2020s'],
		['1975-76', '1900s'],
		['350 BCE', 'pre-1900'],
		// The docstring claims this parses; it does not — the year is two digits
		// and the regex needs three. Recorded, not endorsed.
		['c. 55 CE', 'unknown'],
		['no year here', 'unknown'],
	])('%s → %s', (input, expected) => {
		expect(deriveLibraryDecade(input)).toBe(expected);
	});
});

describe('getLibraryBooks', () => {
	it('returns every work with enrichment counts and totals', async () => {
		const result = await getLibraryBooks(db.d1, {}, ids.userAdmin);
		expect(result.books).toHaveLength(5);
		expect(result.totals).toEqual({ books: 5, quotes: 2, notes: 2 });
	});

	it('excludes superseded quotes, notes and essays from the counts', async () => {
		const { books } = await getLibraryBooks(db.d1, {}, ids.userAdmin);
		const bge = books.find((b) => b.id === ids.bookBeyondGoodAndEvil)!;
		expect(bge.quote_count).toBe(1);
		expect(bge.note_count).toBe(1);
		expect(bge.citation_count).toBe(2);
		expect(bge.media_count).toBe(2);
	});

	it('reports zeroes rather than omitting a work with no writing attached', async () => {
		const { books } = await getLibraryBooks(db.d1, {}, ids.userAdmin);
		const recent = books.find((b) => b.id === ids.bookRecent)!;
		expect(recent).toMatchObject({
			quote_count: 0,
			note_count: 0,
			citation_count: 0,
			media_count: 0,
			has_pdf: 0,
			decade: '2020s',
		});
		expect(recent.last_activity_at).toBe('2026-05-01T00:00:00.000Z');
	});

	it('carries author dates through the join, and null when there is no author row', async () => {
		const { books } = await getLibraryBooks(db.d1, {}, ids.userAdmin);
		const bge = books.find((b) => b.id === ids.bookBeyondGoodAndEvil)!;
		expect(bge.author_born).toBe('1844');
		expect(bge.author_died).toBe('1900');

		const pamphlet = books.find((b) => b.id === ids.bookAnonymousPamphlet)!;
		expect(pamphlet.author_born).toBeNull();
		expect(pamphlet.author_id).toBeNull();
		expect(pamphlet.decade).toBe('unknown');
	});

	it('filters on has_pdf in SQL and on decade in memory', async () => {
		expect(
			(await getLibraryBooks(db.d1, { hasPdf: true }, ids.userAdmin))
				.books
		).toHaveLength(2);
		expect(
			(await getLibraryBooks(db.d1, { hasPdf: false }, ids.userAdmin))
				.books
		).toHaveLength(3);
		expect(
			(
				await getLibraryBooks(
					db.d1,
					{ decade: 'pre-1900' },
					ids.userAdmin
				)
			).books
		).toHaveLength(2);
	});

	it('searches title and author case-insensitively', async () => {
		expect(
			(await getLibraryBooks(db.d1, { search: 'gravity' }, ids.userAdmin))
				.books
		).toHaveLength(1);
		expect(
			(
				await getLibraryBooks(
					db.d1,
					{ search: 'NIETZSCHE' },
					ids.userAdmin
				)
			).books
		).toHaveLength(2);
	});

	it.each([
		[
			'author_az',
			[
				'An Anonymous Pamphlet',
				'The Gay Science',
				'Beyond Good and Evil',
				'Gravity and Grace',
				'A Recent Thing',
			],
		],
		[
			'recent',
			[
				'A Recent Thing',
				'The Gay Science',
				'An Anonymous Pamphlet',
				'Gravity and Grace',
				'Beyond Good and Evil',
			],
		],
		[
			'year',
			[
				'An Anonymous Pamphlet',
				'The Gay Science',
				'Beyond Good and Evil',
				'Gravity and Grace',
				'A Recent Thing',
			],
		],
	] as const)('orders by %s', async (sort, expected) => {
		const { books } = await getLibraryBooks(db.d1, { sort }, ids.userAdmin);
		expect(books.map((b) => b.title)).toEqual(expected);
	});

	it('honours limit and offset', async () => {
		const { books } = await getLibraryBooks(
			db.d1,
			{ limit: 2, offset: 1 },
			ids.userAdmin
		);
		expect(books).toHaveLength(2);
		expect(books[0].title).toBe('The Gay Science');
	});

	it('matches the recorded payload shape', async () => {
		const { books } = await getLibraryBooks(db.d1, {}, ids.userAdmin);
		expect(
			books.find((b) => b.id === ids.bookBeyondGoodAndEvil)
		).toMatchSnapshot();
	});
});

describe('getBookDetail', () => {
	it('returns null for an unknown id', async () => {
		expect(await getBookDetail(db.d1, 'nope', ids.userAdmin)).toBeNull();
	});

	it('returns the work with its author, writing and media', async () => {
		const detail = (await getBookDetail(
			db.d1,
			ids.bookBeyondGoodAndEvil,
			ids.userAdmin
		))!;
		expect(detail.book.title).toBe('Beyond Good and Evil');
		expect(detail.author?.name).toBe('Friedrich Nietzsche');
		expect(detail.quotes.map((q) => q.id)).toEqual([ids.quoteBgeCurrent]);
		expect(detail.notes.map((n) => n.id)).toEqual([ids.noteBge]);
		expect(detail.media.map((m) => m.id)).toEqual([
			ids.mediaBgeFirst,
			ids.mediaBgeSecond,
		]);
		expect(detail.stats).toEqual({
			quotes: 1,
			notes: 1,
			essays: 2,
			media: 2,
		});
	});

	it('ranks related works by essay co-citation', async () => {
		const detail = (await getBookDetail(
			db.d1,
			ids.bookBeyondGoodAndEvil,
			ids.userAdmin
		))!;
		expect(detail.related.map((r) => r.id)).toEqual([
			ids.bookGravityAndGrace,
			ids.bookGayScience,
		]);
		expect(detail.related.every((r) => r.co_citations === 1)).toBe(true);
	});

	it('omits the work itself from its own related list', async () => {
		const detail = (await getBookDetail(
			db.d1,
			ids.bookBeyondGoodAndEvil,
			ids.userAdmin
		))!;
		expect(detail.related.map((r) => r.id)).not.toContain(
			ids.bookBeyondGoodAndEvil
		);
	});

	it('leaves author null when the work has no author row', async () => {
		const detail = (await getBookDetail(
			db.d1,
			ids.bookAnonymousPamphlet,
			ids.userAdmin
		))!;
		expect(detail.author).toBeNull();
		expect(detail.quotes).toEqual([]);
		expect(detail.related).toEqual([]);
		expect(detail.stats).toEqual({
			quotes: 0,
			notes: 1,
			essays: 0,
			media: 0,
		});
	});

	it('matches the recorded payload shape', async () => {
		expect(
			await getBookDetail(db.d1, ids.bookBeyondGoodAndEvil, ids.userAdmin)
		).toMatchSnapshot();
	});
});

/**
 * The catalogue is shared; what a reader made of it is not. Everything in the
 * fixture belongs to userAdmin, so userOther is the second reader arriving at
 * the same shelf: they see every book and none of the writing. This is the
 * test that fails if the user_id filters are ever dropped from enrichment.ts.
 */
describe('a second reader sees the shelf and none of the marginalia', () => {
	it('counts only their own quotes, notes and citations', async () => {
		const { books, totals } = await getLibraryBooks(
			db.d1,
			{},
			ids.userOther
		);
		expect(books).toHaveLength(5);
		expect(totals).toEqual({ books: 5, quotes: 0, notes: 0 });
		for (const book of books) {
			expect(book.quote_count).toBe(0);
			expect(book.note_count).toBe(0);
			expect(book.citation_count).toBe(0);
		}
	});

	it('is given the work, its author and its media all the same', async () => {
		const detail = (await getBookDetail(
			db.d1,
			ids.bookBeyondGoodAndEvil,
			ids.userOther
		))!;
		expect(detail.book.title).toBe('Beyond Good and Evil');
		expect(detail.author?.name).toBe('Friedrich Nietzsche');
		expect(detail.media.map((m) => m.id)).toEqual([
			ids.mediaBgeFirst,
			ids.mediaBgeSecond,
		]);
	});

	it('is given none of the other reader’s writing', async () => {
		const detail = (await getBookDetail(
			db.d1,
			ids.bookBeyondGoodAndEvil,
			ids.userOther
		))!;
		expect(detail.quotes).toEqual([]);
		expect(detail.notes).toEqual([]);
		expect(detail.essays).toEqual([]);
		expect(detail.stats).toEqual({
			quotes: 0,
			notes: 0,
			essays: 0,
			media: 2,
		});
	});

	it('cannot read a co-citation out of an essay it may not see', async () => {
		const detail = (await getBookDetail(
			db.d1,
			ids.bookBeyondGoodAndEvil,
			ids.userOther
		))!;
		expect(detail.related).toEqual([]);
	});
});
