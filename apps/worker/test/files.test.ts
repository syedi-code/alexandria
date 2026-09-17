import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import router from '../api/router.js';
import {
	migratedTestDatabase,
	type TestDatabase,
} from '../../../packages/core/test/d1.js';
import { signFileToken } from '@alexandria/core/platform';

const SECRET = 'file-signing-secret-for-tests';
const KEY = 'books/8f1c/leviathan.pdf';
const BYTES = 'a pdf, as far as anyone here is concerned';

let db: TestDatabase;
let reads: string[];

/** Records what was asked for, so a leak shows up as a read that happened. */
const bucket = () => {
	reads = [];
	return {
		get(key: string) {
			reads.push(key);
			if (key !== KEY) return null;
			return {
				body: BYTES,
				httpMetadata: { contentType: 'application/pdf' },
			};
		},
	};
};

let R2_BUCKET: ReturnType<typeof bucket>;

const call = (path: string, init: RequestInit = {}) =>
	router.fetch(new Request(`http://alexandria.test${path}`, init), {
		DB: db.d1,
		R2_BUCKET,
		FILE_SIGNING_SECRET: SECRET,
		ADMIN_EMAIL: 'admin@example.test',
		LOCAL_DEV: 'false',
	});

const signIn = (): string => {
	db.raw
		.prepare(
			`INSERT OR IGNORE INTO users (id, email, first_seen, last_seen)
			 VALUES (?, ?, ?, ?)`
		)
		.run(
			'user-admin',
			'admin@example.test',
			'2026-01-01T00:00:00.000Z',
			'2026-01-01T00:00:00.000Z'
		);
	db.raw
		.prepare(
			`INSERT INTO sessions (token, user_id, email, role, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(
			'session-token',
			'user-admin',
			'admin@example.test',
			'admin',
			'2026-01-01T00:00:00.000Z',
			'2099-01-01T00:00:00.000Z'
		);
	return '__session=session-token';
};

beforeEach(() => {
	db = migratedTestDatabase();
	R2_BUCKET = bucket();
});

afterEach(() => db.close());

/**
 * `/files/*` is served before session auth so that a signed URL works in an
 * <img> tag and a PDF viewer. A regression here is not a broken feature, it is
 * the whole bucket on the open internet — which is what shipped when the check
 * tested that `?token=` was present rather than valid.
 */
describe('GET /api/files/* without a session', () => {
	it('refuses a request carrying no token', async () => {
		const response = await call(`/api/files/${KEY}`);
		expect(response.status).toBe(401);
		expect(reads).toEqual([]);
	});

	it('refuses an unsigned token, and does not touch the bucket', async () => {
		for (const token of ['x', 'true', '1', 'null', '{}']) {
			const response = await call(`/api/files/${KEY}?token=${token}`);
			expect(response.status).toBe(401);
		}
		expect(reads).toEqual([]);
	});

	it('refuses a token forged with a different secret', async () => {
		const token = await signFileToken({ key: KEY, secret: 'not-it' });
		const response = await call(
			`/api/files/${KEY}?token=${encodeURIComponent(token)}`
		);
		expect(response.status).toBe(401);
		expect(reads).toEqual([]);
	});

	it('refuses a token minted for a different object', async () => {
		const token = await signFileToken({
			key: 'books/other.pdf',
			secret: SECRET,
		});
		const response = await call(
			`/api/files/${KEY}?token=${encodeURIComponent(token)}`
		);
		expect(response.status).toBe(401);
		expect(reads).toEqual([]);
	});

	it('serves the object for a token signed for it', async () => {
		const token = await signFileToken({ key: KEY, secret: SECRET });
		const response = await call(
			`/api/files/${KEY}?token=${encodeURIComponent(token)}`
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/pdf');
		expect(response.headers.get('Cache-Control')).toContain('private');
		expect(reads).toEqual([KEY]);
	});

	it('serves it under the bare /files prefix too', async () => {
		const token = await signFileToken({ key: KEY, secret: SECRET });
		const response = await call(
			`/files/${KEY}?token=${encodeURIComponent(token)}`
		);
		expect(response.status).toBe(200);
	});

	it('refuses every token when the deployment has no signing secret', async () => {
		const token = await signFileToken({ key: KEY, secret: SECRET });
		const response = await router.fetch(
			new Request(
				`http://alexandria.test/api/files/${KEY}?token=${encodeURIComponent(token)}`
			),
			{ DB: db.d1, R2_BUCKET, LOCAL_DEV: 'false' }
		);
		expect(response.status).toBe(401);
		expect(reads).toEqual([]);
	});
});

describe('GET /api/files/* with a session', () => {
	it('serves the object', async () => {
		const response = await call(`/api/files/${KEY}`, {
			headers: { cookie: signIn() },
		});
		expect(response.status).toBe(200);
		expect(reads).toEqual([KEY]);
	});

	it('reports a missing object as missing', async () => {
		const response = await call('/api/files/books/absent.pdf', {
			headers: { cookie: signIn() },
		});
		expect(response.status).toBe(404);
	});
});

describe('POST /files/sign', () => {
	it('mints a token the file route accepts', async () => {
		const signed = await call('/files/sign', {
			method: 'POST',
			headers: { 'cookie': signIn(), 'content-type': 'application/json' },
			body: JSON.stringify({ path: KEY }),
		});
		expect(signed.status).toBe(200);

		const { token } = (await signed.json()) as { token: string };
		const response = await call(
			`/api/files/${KEY}?token=${encodeURIComponent(token)}`
		);
		expect(response.status).toBe(200);
	});

	it('refuses to sign without a session', async () => {
		const response = await call('/files/sign', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: KEY }),
		});
		expect(response.status).toBe(401);
	});

	it('refuses to sign a key that escapes the bucket', async () => {
		const response = await call('/files/sign', {
			method: 'POST',
			headers: { 'cookie': signIn(), 'content-type': 'application/json' },
			body: JSON.stringify({ path: '../../etc/passwd' }),
		});
		expect(response.status).toBe(400);
	});
});
