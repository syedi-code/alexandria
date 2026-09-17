import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	migratedTestDatabase,
	applyMigrations,
	type TestDatabase,
} from './d1.js';
import { seedLegacyCatalogue, ids } from './fixture.js';

const LAST_LEGACY = '0025';
const WORKS = '0026';

type Row = Record<string, unknown>;
const rows = (db: TestDatabase, sql: string): Row[] =>
	db.raw
		.prepare(sql)
		.all()
		.map((r) => ({ ...(r as object) }));

let db: TestDatabase;
let before: {
	books: Row[];
	authors: Row[];
	media: Row[];
	notes: Row[];
	quotes: Row[];
	references: Row[];
};

beforeAll(() => {
	db = migratedTestDatabase({ to: LAST_LEGACY });
	seedLegacyCatalogue(db);
	before = {
		books: rows(db, 'SELECT * FROM books ORDER BY id'),
		authors: rows(db, 'SELECT * FROM authors ORDER BY id'),
		media: rows(db, 'SELECT * FROM book_media ORDER BY id'),
		notes: rows(db, 'SELECT * FROM notes ORDER BY id'),
		quotes: rows(db, 'SELECT * FROM quotes ORDER BY id'),
		references: rows(db, 'SELECT * FROM essay_references ORDER BY id'),
	};
	applyMigrations(db, { from: WORKS });
});

afterAll(() => db.close());

describe('0026_works — identity', () => {
	it('preserves every work id, with nothing added or dropped', () => {
		expect(
			rows(db, 'SELECT id FROM works ORDER BY id').map((r) => r.id)
		).toEqual(before.books.map((b) => b.id));
	});

	it('preserves every creator id', () => {
		expect(
			rows(db, 'SELECT id FROM creators ORDER BY id').map((r) => r.id)
		).toEqual(before.authors.map((a) => a.id));
	});

	it('preserves every media id and its parent', () => {
		const after = rows(
			db,
			'SELECT id, work_id FROM work_media ORDER BY id'
		);
		expect(after.map((m) => m.id)).toEqual(before.media.map((m) => m.id));
		expect(after.map((m) => m.work_id)).toEqual(
			before.media.map((m) => m.book_id)
		);
	});

	it('leaves writing untouched — notes and quotes still point at the same ids', () => {
		expect(rows(db, 'SELECT * FROM notes ORDER BY id')).toEqual(
			before.notes
		);
		expect(rows(db, 'SELECT * FROM quotes ORDER BY id')).toEqual(
			before.quotes
		);
	});

	it('leaves essay_references untouched, entity_type included', () => {
		expect(rows(db, 'SELECT * FROM essay_references ORDER BY id')).toEqual(
			before.references
		);
	});
});

describe('0026_works — fields', () => {
	it('carries the scalar columns across under their new names', () => {
		const after = rows(
			db,
			'SELECT id, title, creator, creator_id, cover_key, isbn, description, originally_published, kind, deleted_at, created_at, updated_at FROM works ORDER BY id'
		);
		for (const [i, b] of before.books.entries()) {
			expect(after[i]).toMatchObject({
				id: b.id,
				title: b.title,
				creator: b.author,
				creator_id: b.author_id,
				cover_key: b.cover_url,
				isbn: b.isbn,
				description: b.description,
				originally_published: b.originally_published,
				created_at: b.created_at,
				updated_at: b.updated_at,
			});
		}
	});

	it('defaults every migrated work to kind=book and not deleted', () => {
		const after = rows(db, 'SELECT kind, deleted_at FROM works');
		expect(after.every((w) => w.kind === 'book')).toBe(true);
		expect(after.every((w) => w.deleted_at === null)).toBe(true);
	});

	it('renames book_media.path to r2_key without touching the values', () => {
		const after = rows(db, 'SELECT id, r2_key FROM work_media ORDER BY id');
		expect(after.map((m) => m.r2_key)).toEqual(
			before.media.map((m) => m.path)
		);
	});
});

describe('0026_works — documents', () => {
	it('creates exactly one document per work that had a PDF', () => {
		const withPdf = before.books.filter((b) => b.pdf_url !== null);
		expect(rows(db, 'SELECT id FROM documents')).toHaveLength(
			withPdf.length
		);
	});

	it('moves pdf_url and pdf_page_offset onto the document', () => {
		for (const book of before.books.filter((b) => b.pdf_url !== null)) {
			const doc = db.raw
				.prepare('SELECT * FROM documents WHERE work_id = ?')
				.get(book.id as string) as Row;
			expect(doc.r2_key).toBe(book.pdf_url);
			expect(doc.page_offset).toBe(book.pdf_page_offset);
			expect(doc.is_primary).toBe(1);
		}
	});

	it('points each work at its primary document, and leaves the rest null', () => {
		for (const book of before.books) {
			const work = db.raw
				.prepare('SELECT primary_document_id FROM works WHERE id = ?')
				.get(book.id as string) as Row;
			if (book.pdf_url === null) {
				expect(work.primary_document_id).toBeNull();
			} else {
				expect(work.primary_document_id).toEqual(
					(
						db.raw
							.prepare(
								'SELECT id FROM documents WHERE work_id = ?'
							)
							.get(book.id as string) as Row
					).id
				);
			}
		}
	});

	it('gives every document a distinct v4-shaped id', () => {
		const docIds = rows(db, 'SELECT id FROM documents').map(
			(d) => d.id as string
		);
		expect(new Set(docIds).size).toBe(docIds.length);
		for (const id of docIds) {
			expect(id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
			);
		}
	});

	it('drops the columns documents now own', () => {
		const columns = rows(
			db,
			'SELECT * FROM pragma_table_info(?)'.replace('?', "'works'")
		).map((c) => c.name);
		expect(columns).not.toContain('pdf_url');
		expect(columns).not.toContain('pdf_page_offset');
	});
});

describe('0026_works — referential integrity', () => {
	it('repoints the notes and quotes foreign keys at works', () => {
		for (const table of ['notes', 'quotes']) {
			const ddl = (
				db.raw
					.prepare('SELECT sql FROM sqlite_master WHERE name = ?')
					.get(table) as Row
			).sql as string;
			expect(ddl).toContain('REFERENCES "works"(id)');
		}
	});

	it('accepts a new note against a migrated work with foreign keys on', () => {
		db.raw.exec('PRAGMA foreign_keys = ON');
		expect(() =>
			db.raw
				.prepare(
					`INSERT INTO notes (id, content, book_id, posted, source, created_at, updated_at, user_id)
					 VALUES (?, ?, ?, 0, 'web', ?, ?, ?)`
				)
				.run(
					'fk-check',
					'Still attaches.',
					ids.bookBeyondGoodAndEvil,
					'2026-09-15T00:00:00.000Z',
					'2026-09-15T00:00:00.000Z',
					ids.userAdmin
				)
		).not.toThrow();
		db.raw.prepare('DELETE FROM notes WHERE id = ?').run('fk-check');
	});

	it('reports no foreign key violations anywhere', () => {
		expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
	});
});

describe('0026_works — essay tokens', () => {
	it('resolves every [[book:UUID]] token in every essay against works', () => {
		const unresolved: string[] = [];
		for (const essay of rows(db, 'SELECT id, content FROM essays')) {
			const content = essay.content as string;
			for (const match of content.matchAll(
				/\[\[(?:book|book_cover):([0-9a-fA-F-]{36})/g
			)) {
				const hit = db.raw
					.prepare('SELECT id FROM works WHERE id = ?')
					.get(match[1]);
				if (!hit) unresolved.push(`${essay.id} → ${match[1]}`);
			}
		}
		expect(unresolved).toEqual([]);
	});
});
