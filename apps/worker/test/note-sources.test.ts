import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import router from '../api/router.js';
import {
	migratedTestDatabase,
	type TestDatabase,
} from '../../../packages/core/test/d1.js';

interface NoteBody {
	id: string;
	book: { id: string; title: string } | null;
	author: { id: string; name: string } | null;
}

let db: TestDatabase;
const ADMIN = { id: 'user-admin', email: 'admin@example.test' };
const COOKIE = '__session=token-admin';

const call = (path: string, init: RequestInit = {}) =>
	router.fetch(
		new Request(`http://alexandria.test${path}`, {
			...init,
			headers: {
				'Content-Type': 'application/json',
				'cookie': COOKIE,
				...(init.headers ?? {}),
			},
		}),
		{ DB: db.d1, ADMIN_EMAIL: ADMIN.email, LOCAL_DEV: 'false' }
	);

async function post<T>(path: string, body: unknown): Promise<T> {
	const response = await call(path, {
		method: 'POST',
		body: JSON.stringify(body),
	});
	expect(response.status).toBeLessThan(300);
	return (await response.json()) as T;
}

beforeEach(() => {
	db = migratedTestDatabase();
	db.raw
		.prepare(
			`INSERT INTO users (id, email, first_seen, last_seen) VALUES (?, ?, ?, ?)`
		)
		.run(
			ADMIN.id,
			ADMIN.email,
			'2026-01-01T00:00:00.000Z',
			'2026-01-01T00:00:00.000Z'
		);
	db.raw
		.prepare(
			`INSERT INTO sessions (token, user_id, email, role, created_at, expires_at)
			 VALUES (?, ?, ?, 'admin', ?, ?)`
		)
		.run(
			'token-admin',
			ADMIN.id,
			ADMIN.email,
			'2026-01-01T00:00:00.000Z',
			'2099-01-01T00:00:00.000Z'
		);
});

afterEach(() => db.close());

async function seed() {
	const { author } = await post<{ author: { id: string } }>('/authors', {
		name: 'Frantz Fanon',
	});
	const { book } = await post<{ book: { id: string } }>('/books', {
		title: 'The Wretched of the Earth',
		author: 'Frantz Fanon',
	});
	await post('/notes', {
		id: 'note-book',
		content: 'On violence.',
		book_id: book.id,
	});
	await post('/notes', {
		id: 'note-author',
		content: 'On national culture.',
		connections: [
			{
				a_type: 'note',
				a_id: 'note-author',
				b_type: 'author',
				b_id: author.id,
			},
		],
	});
	await post('/notes', { id: 'note-bare', content: 'A thought of my own.' });
	return { author, book };
}

describe('notes carry their sources', () => {
	it('in the list: the book, else the connected author, else neither', async () => {
		const { author, book } = await seed();
		const { notes } = (await (await call('/notes')).json()) as {
			notes: NoteBody[];
		};
		const byId = new Map(notes.map((n) => [n.id, n]));

		expect(byId.get('note-book')?.book?.id).toBe(book.id);
		expect(byId.get('note-book')?.book?.title).toBe(
			'The Wretched of the Earth'
		);
		expect(byId.get('note-book')?.author).toBeNull();
		expect(byId.get('note-author')?.book).toBeNull();
		expect(byId.get('note-author')?.author).toMatchObject({
			id: author.id,
			name: 'Frantz Fanon',
		});
		expect(byId.get('note-bare')).toMatchObject({
			book: null,
			author: null,
		});
	});

	it('in the shuffle, by id, and in the note a create returns', async () => {
		const { book } = await seed();

		const { notes } = (await (
			await call('/notes/shuffle?count=5')
		).json()) as {
			notes: NoteBody[];
		};
		expect(notes.find((n) => n.id === 'note-book')?.book?.id).toBe(book.id);

		const { note } = (await (await call('/notes/note-author')).json()) as {
			note: NoteBody;
		};
		expect(note.author?.name).toBe('Frantz Fanon');

		const created = await post<{ note: NoteBody }>('/notes', {
			content: 'Again.',
			book_id: book.id,
		});
		expect(created.note.book?.id).toBe(book.id);
	});

	it('keeps resolving a book after it is deleted, as essays cite it', async () => {
		const { book } = await seed();
		expect(
			(await call(`/books/${book.id}`, { method: 'DELETE' })).status
		).toBe(200);

		const { note } = (await (await call('/notes/note-book')).json()) as {
			note: NoteBody;
		};
		expect(note.book?.id).toBe(book.id);
	});
});
