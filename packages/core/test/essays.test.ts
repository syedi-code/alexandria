import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TestDatabase } from './d1.js';
import { catalogueTestDatabase, ids } from './fixture.js';
import { getEssays, getEssayById } from '../writing/essays.js';

let db: TestDatabase;

beforeEach(() => {
	db = catalogueTestDatabase();
});

afterEach(() => db.close());

describe('essay references over works', () => {
	it('lists essays with their cited works joined', async () => {
		const { data } = await getEssays(db.d1, {}, ids.userAdmin);

		const essay = data.find((e) => e.id === ids.essayCoCitation)!;
		expect(essay.references.map((r) => r.book_title)).toEqual([
			'Beyond Good and Evil',
			'Gravity and Grace',
		]);
		expect(essay.references[0].book_author).toBe('Friedrich Nietzsche');
		expect(essay.references[0].book_cover_url).toBe('books/bge/cover.jpg');
	});

	it('joins a quote reference and the work behind it', async () => {
		await db.raw
			.prepare(
				`INSERT INTO essay_references (id, essay_id, entity_type, entity_id, page, position, params)
				 VALUES (?, ?, 'quote', ?, NULL, 2, NULL)`
			)
			.run(
				`${ids.essayCoCitation}:2`,
				ids.essayCoCitation,
				ids.quoteBgeCurrent
			);

		const essay = (await getEssayById(
			db.d1,
			ids.essayCoCitation,
			ids.userAdmin
		))!;
		const quoteRef = essay.references.find(
			(r) => r.entity_type === 'quote'
		)!;
		expect(quoteRef.quote_text).toBe('He who fights with monsters.');
		expect(quoteRef.book_title).toBe('Beyond Good and Evil');
		expect(quoteRef.book_author).toBe('Friedrich Nietzsche');
	});
});
