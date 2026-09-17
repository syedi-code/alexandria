import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TestDatabase } from './d1.js';
import { catalogueTestDatabase, ids } from './fixture.js';
import {
	createBook,
	getBookById,
	getBooks,
	updateBook,
	deleteBook,
	listDocuments,
	listCatalogue,
	createWork,
	getWorkById,
	restoreWork,
} from '../works/index.js';

let db: TestDatabase;

beforeEach(() => {
	db = catalogueTestDatabase();
});

afterEach(() => db.close());

describe('the Book facade over works', () => {
	it('creates a work and its primary document from one Book payload', async () => {
		const book = await createBook(
			db.d1,
			{
				title: 'The Human Condition',
				author: 'Hannah Arendt',
				pdf_url: 'books/arendt/hc.pdf',
				pdf_page_offset: 8,
				originally_published: '1958',
			},
			ids.userAdmin
		);

		expect(book.pdf_url).toBe('books/arendt/hc.pdf');
		expect(book.pdf_page_offset).toBe(8);

		const documents = await listDocuments(db.d1, book.id);
		expect(documents).toHaveLength(1);
		expect(documents[0].is_primary).toBe(1);

		const work = (await getWorkById(db.d1, book.id))!;
		expect(work.kind).toBe('book');
		expect(work.primary_document_id).toBe(documents[0].id);
	});

	it('creates no document for a work with no file', async () => {
		const book = await createBook(
			db.d1,
			{ title: 'A Pamphlet', author: 'Anon' },
			ids.userAdmin
		);
		expect(await listDocuments(db.d1, book.id)).toEqual([]);
		expect((await getBookById(db.d1, book.id))!.pdf_url).toBeNull();
		expect((await getBookById(db.d1, book.id))!.pdf_page_offset).toBe(0);
	});

	it('attaches a document when a PDF arrives after the fact', async () => {
		const book = await createBook(
			db.d1,
			{ title: 'Later', author: 'Anon' },
			ids.userAdmin
		);
		await updateBook(db.d1, book.id, { pdf_url: 'books/later/l.pdf' });

		const documents = await listDocuments(db.d1, book.id);
		expect(documents).toHaveLength(1);
		expect((await getWorkById(db.d1, book.id))!.primary_document_id).toBe(
			documents[0].id
		);
		expect((await getBookById(db.d1, book.id))!.pdf_url).toBe(
			'books/later/l.pdf'
		);
	});

	it('updates the existing document rather than adding a second', async () => {
		await updateBook(db.d1, ids.bookBeyondGoodAndEvil, {
			pdf_page_offset: 20,
		});
		const documents = await listDocuments(db.d1, ids.bookBeyondGoodAndEvil);
		expect(documents).toHaveLength(1);
		expect(documents[0].page_offset).toBe(20);
		expect(
			(await getBookById(db.d1, ids.bookBeyondGoodAndEvil))!
				.pdf_page_offset
		).toBe(20);
	});

	it('leaves the other Book fields alone when only the file changes', async () => {
		const before = (await getBookById(db.d1, ids.bookBeyondGoodAndEvil))!;
		await updateBook(db.d1, ids.bookBeyondGoodAndEvil, {
			pdf_page_offset: 20,
		});
		const after = (await getBookById(db.d1, ids.bookBeyondGoodAndEvil))!;
		expect({
			...after,
			pdf_page_offset: before.pdf_page_offset,
			updated_at: before.updated_at,
		}).toEqual(before);
	});
});

describe('soft delete (D21)', () => {
	it('hides a deleted work from every listing', async () => {
		await deleteBook(db.d1, ids.bookRecent);

		expect((await getBooks(db.d1)).map((b) => b.id)).not.toContain(
			ids.bookRecent
		);
		const catalogue = await listCatalogue(db.d1);
		expect(catalogue.rows.map((r) => r.id)).not.toContain(ids.bookRecent);
		expect(catalogue.total).toBe(4);
	});

	it('still resolves a deleted work by id, because essays cite it', async () => {
		await deleteBook(db.d1, ids.bookBeyondGoodAndEvil);
		const book = await getBookById(db.d1, ids.bookBeyondGoodAndEvil);
		expect(book?.title).toBe('Beyond Good and Evil');
	});

	it('survives deletion of a work that notes and quotes point at', async () => {
		db.raw.exec('PRAGMA foreign_keys = ON');
		await expect(
			deleteBook(db.d1, ids.bookBeyondGoodAndEvil)
		).resolves.toBeUndefined();
		expect(
			db.raw
				.prepare('SELECT COUNT(*) AS c FROM notes WHERE book_id = ?')
				.get(ids.bookBeyondGoodAndEvil)
		).toMatchObject({ c: 2 });
	});

	it('is reversible', async () => {
		await deleteBook(db.d1, ids.bookRecent);
		await restoreWork(db.d1, ids.bookRecent);
		expect((await getBooks(db.d1)).map((b) => b.id)).toContain(
			ids.bookRecent
		);
	});
});

describe('kinds other than book', () => {
	it('keeps a non-book work out of the Book facade', async () => {
		const lecture = await createWork(
			db.d1,
			{
				kind: 'lecture',
				title: 'What Is Called Thinking?',
				creator: 'Martin Heidegger',
			},
			ids.userAdmin
		);

		expect((await getBooks(db.d1)).map((b) => b.id)).not.toContain(
			lecture.id
		);
		expect(await getBookById(db.d1, lecture.id)).toBeNull();
		expect((await getWorkById(db.d1, lecture.id))!.kind).toBe('lecture');
	});
});
