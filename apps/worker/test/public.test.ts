import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import router from '../api/router.js';
import {
	migratedTestDatabase,
	type TestDatabase,
} from '../../../packages/core/test/d1.js';

interface Catalogue {
	works: {
		work_id: string;
		title: string;
		creator: string;
		documents: { document_id: string; has_file: boolean }[];
	}[];
}

let db: TestDatabase;

const work = (id: string, title: string, creator: string) =>
	db.raw
		.prepare(
			`INSERT INTO works (id, kind, title, creator, created_at, updated_at)
			 VALUES (?, 'book', ?, ?, '2026-01-01', '2026-01-01')`
		)
		.run(id, title, creator);

const document = (id: string, workId: string, key: string | null) =>
	db.raw
		.prepare(
			`INSERT INTO documents (id, work_id, r2_key, page_offset, is_primary, created_at, updated_at)
			 VALUES (?, ?, ?, 0, 1, '2026-01-01', '2026-01-01')`
		)
		.run(id, workId, key);

const call = (env: Record<string, unknown> = {}) =>
	router.fetch(new Request('http://alexandria.test/catalogue'), {
		DB: db.d1,
		...env,
	});

beforeEach(() => {
	db = migratedTestDatabase();
	work('w-held', 'Leviathan', 'Thomas Hobbes');
	document('d-held', 'w-held', 'books/w-held/leviathan.pdf');

	work('w-empty', 'Awaiting Upload', 'Nobody');
	document('d-empty', 'w-empty', null);

	work('w-gone', 'Deleted Work', 'Nobody');
	document('d-gone', 'w-gone', 'books/w-gone/x.pdf');
	db.raw
		.prepare(
			`UPDATE works SET deleted_at = '2026-02-01' WHERE id = 'w-gone'`
		)
		.run();
});

afterEach(() => db.close());

describe('GET /api/catalogue', () => {
	it('is not served at all unless the deployment opts in', async () => {
		expect((await call()).status).toBe(404);
		expect((await call({ PUBLIC_CATALOGUE: 'false' })).status).toBe(404);
		expect((await call({ PUBLIC_CATALOGUE: '1' })).status).toBe(404);
	});

	it('answers without a session when it is on', async () => {
		const response = await call({ PUBLIC_CATALOGUE: 'true' });
		expect(response.status).toBe(200);
	});

	it('lists works whose document has a file', async () => {
		const body = (await (
			await call({ PUBLIC_CATALOGUE: 'true' })
		).json()) as Catalogue;
		expect(body.works.map((w) => w.title)).toEqual(['Leviathan']);
	});

	it('omits a work whose document has no file yet', async () => {
		const body = (await (
			await call({ PUBLIC_CATALOGUE: 'true' })
		).json()) as Catalogue;
		expect(body.works.map((w) => w.work_id)).not.toContain('w-empty');
	});

	it('omits a soft-deleted work', async () => {
		const body = (await (
			await call({ PUBLIC_CATALOGUE: 'true' })
		).json()) as Catalogue;
		expect(body.works.map((w) => w.work_id)).not.toContain('w-gone');
	});

	// The whole safety argument for making this public: it is a bibliography.
	it('discloses no bucket key, page text or writing', async () => {
		const raw = await (await call({ PUBLIC_CATALOGUE: 'true' })).text();
		expect(raw).not.toContain('books/w-held');
		expect(raw).not.toContain('r2_key');
		expect(raw).not.toContain('file_key');
	});

	it('does not open any other route to the public', async () => {
		for (const path of ['/books', '/notes', '/me', '/essays']) {
			const response = await router.fetch(
				new Request(`http://alexandria.test${path}`),
				{ DB: db.d1, PUBLIC_CATALOGUE: 'true' }
			);
			expect(response.status).toBe(401);
		}
	});
});
