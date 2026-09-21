import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import router from '../api/router.js';
import {
	migratedTestDatabase,
	type TestDatabase,
} from '../../../packages/core/test/d1.js';
import { apiContract, type ApiContract } from '@alexandria/core';

interface SessionBody {
	user: { id: string; email: string };
	role: 'admin' | 'member';
	contract: ApiContract;
}
interface MeBody {
	user: {
		id: string;
		email: string;
		role: 'admin' | 'member';
		plan: 'free' | 'paid';
	};
	contract: ApiContract;
}
interface ErrorBody {
	error: string;
	code?: string;
}
interface BooksBody {
	books: { id: string; title: string }[];
}

async function json<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

let db: TestDatabase;

const ADMIN = { id: 'user-admin', email: 'admin@example.test' };
const MEMBER = { id: 'user-member', email: 'member@example.test' };

const baseEnv = () => ({
	DB: db.d1,
	ADMIN_EMAIL: ADMIN.email,
	LOCAL_DEV: 'false',
});

/** A real session row plus its cookie, rather than the LOCAL_DEV shortcut. */
function signIn(who: typeof ADMIN, role: 'admin' | 'member'): string {
	const token = `token-${role}`;
	db.raw
		.prepare(
			`INSERT OR IGNORE INTO users (id, email, first_seen, last_seen) VALUES (?, ?, ?, ?)`
		)
		.run(
			who.id,
			who.email,
			'2026-01-01T00:00:00.000Z',
			'2026-01-01T00:00:00.000Z'
		);
	db.raw
		.prepare(
			`INSERT INTO sessions (token, user_id, email, role, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(
			token,
			who.id,
			who.email,
			role,
			'2026-01-01T00:00:00.000Z',
			'2099-01-01T00:00:00.000Z'
		);
	return `__session=${token}`;
}

const call = (
	path: string,
	init: RequestInit = {},
	overrides: Record<string, unknown> = {}
) =>
	router.fetch(new Request(`http://alexandria.test${path}`, init), {
		...baseEnv(),
		...overrides,
	});

const as = (cookie: string, path: string, init: RequestInit = {}) =>
	call(path, {
		...init,
		headers: { ...(init.headers ?? {}), cookie },
	});

beforeEach(() => {
	db = migratedTestDatabase();
});

afterEach(() => db.close());

describe('POST /session', () => {
	it('returns the identity and the API contract in local dev', async () => {
		const response = await call(
			'/session',
			{ method: 'POST' },
			{
				LOCAL_DEV: 'true',
			}
		);
		expect(response.status).toBe(200);

		const body = await json<SessionBody>(response);
		expect(body.role).toBe('admin');
		expect(body.user.email).toBe(ADMIN.email);
		expect(body.contract).toEqual(
			JSON.parse(JSON.stringify(apiContract()))
		);
	});

	it('sends limits and an embed vocabulary a client can act on', async () => {
		const body = await json<SessionBody>(
			await call('/session', { method: 'POST' }, { LOCAL_DEV: 'true' })
		);
		expect(body.contract.limits.ESSAY).toBeGreaterThan(0);
		expect(body.contract.embed_param_specs.image.map((s) => s.key)).toEqual(
			['bg', 'caption']
		);
	});

	it('refuses to mint a session without a CF Access assertion', async () => {
		const response = await call('/session', { method: 'POST' });
		expect(response.status).toBe(401);
		expect((await json<ErrorBody>(response)).code).toBe(
			'JWT_VERIFICATION_FAILED'
		);
	});
});

describe('GET /me', () => {
	it('carries the contract too, for a client that already holds a session', async () => {
		const body = await json<MeBody>(
			await as(signIn(ADMIN, 'admin'), '/me')
		);
		expect(body.user.role).toBe('admin');
		expect(body.contract).toEqual(
			JSON.parse(JSON.stringify(apiContract()))
		);
	});

	it('says which plan the reader is on', async () => {
		const body = await json<MeBody>(
			await as(signIn(MEMBER, 'member'), '/me')
		);
		expect(body.user.plan).toBe('free');
	});
});

describe('DELETE /session', () => {
	it('ends the session, so the next Access login is not answered as this one', async () => {
		const cookie = signIn(MEMBER, 'member');

		const response = await as(cookie, '/session', { method: 'DELETE' });
		expect(response.status).toBe(204);
		expect(response.headers.get('set-cookie')).toMatch(
			/__session=;.*Max-Age=0/
		);
		expect(
			db.raw.prepare(`SELECT COUNT(*) AS n FROM sessions`).get()
		).toEqual({ n: 0 });
		expect((await as(cookie, '/me')).status).toBe(401);
	});

	it('succeeds for a reader who holds no session at all', async () => {
		const response = await call('/session', { method: 'DELETE' });
		expect(response.status).toBe(204);
	});
});

describe('who may read and write works', () => {
	it('refuses a read with no session', async () => {
		const response = await call('/books');
		expect(response.status).toBe(401);
		expect((await json<ErrorBody>(response)).code).toBe('SESSION_MISSING');
	});

	it('serves the catalogue to any authenticated reader', async () => {
		const response = await as(signIn(MEMBER, 'member'), '/books/library');
		expect(response.status).toBe(200);
		const body = await json<BooksBody>(response);
		expect(body).toHaveProperty('books');
		expect(body).toHaveProperty('totals');
	});

	it('refuses a write from a member', async () => {
		const response = await as(signIn(MEMBER, 'member'), '/books', {
			method: 'POST',
			body: JSON.stringify({ title: 'The Trial', author: 'Franz Kafka' }),
			headers: { 'Content-Type': 'application/json' },
		});
		expect(response.status).toBe(403);
	});

	it('accepts a write from an admin', async () => {
		const response = await as(signIn(ADMIN, 'admin'), '/books', {
			method: 'POST',
			body: JSON.stringify({ title: 'The Trial', author: 'Franz Kafka' }),
			headers: { 'Content-Type': 'application/json' },
		});
		expect(response.status).toBe(201);

		const created = (
			await json<{ book: { id: string; title: string } }>(response)
		).book;
		expect(created.title).toBe('The Trial');

		const listed = await json<BooksBody>(
			await as(signIn(MEMBER, 'member'), '/books')
		);
		expect(listed.books.map((b) => b.id)).toContain(created.id);
	});
});
