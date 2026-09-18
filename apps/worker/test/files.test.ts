import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import router from '../api/router.js';
import {
	migratedTestDatabase,
	type TestDatabase,
} from '../../../packages/core/test/d1.js';
import { signFileToken } from '@alexandria/core/platform';

const SECRET = 'file-signing-secret-for-tests';
const KEY = 'books/8f1c/leviathan.pdf';
/** Six of production's keys carry a space or a comma; this is one of them. */
const SPACED = 'books/8f1c/Kant, Immanuel - What is Enlightenment.pdf';
const BYTES = 'a pdf, as far as anyone here is concerned';

/** A key travels through a URL a path segment at a time. */
const inUrl = (key: string) => key.split('/').map(encodeURIComponent).join('/');

let db: TestDatabase;
let reads: string[];

/**
 * Records what was asked for, so a leak shows up as a read that happened, and
 * answers a byte range the way R2 does, so the route's arithmetic is tested
 * rather than assumed.
 */
const bucket = () => {
	reads = [];
	return {
		get(key: string, options?: { range?: R2Range }) {
			reads.push(key);
			if (key !== KEY && key !== SPACED) return null;
			const range = options?.range;
			let body = BYTES;
			if (range) {
				if ('suffix' in range) {
					body = BYTES.slice(BYTES.length - range.suffix);
				} else {
					const offset = range.offset ?? 0;
					body = BYTES.slice(
						offset,
						offset + (range.length ?? Infinity)
					);
				}
			}
			return {
				body,
				size: BYTES.length,
				range,
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

/**
 * A reader who wants page 147 of a four-hundred-page scan should not be sent
 * the other three hundred and ninety-nine. Without `Accept-Ranges` a PDF
 * reader cannot ask for less and pulls the whole file — in a measured run of
 * pdf.js against this route as it was, the whole file three times over.
 */
describe('a byte range', () => {
	const signed = async (key = KEY) =>
		`/api/files/${inUrl(key)}?token=${encodeURIComponent(
			await signFileToken({ key, secret: SECRET })
		)}`;

	it('is advertised, with the size, when none was asked for', async () => {
		const response = await call(await signed());
		expect(response.status).toBe(200);
		expect(response.headers.get('Accept-Ranges')).toBe('bytes');
		expect(response.headers.get('Content-Length')).toBe(
			String(BYTES.length)
		);
	});

	it('serves exactly the bytes asked for, and says where they sit', async () => {
		const response = await call(await signed(), {
			headers: { range: 'bytes=2-6' },
		});
		expect(response.status).toBe(206);
		expect(await response.text()).toBe(BYTES.slice(2, 7));
		expect(response.headers.get('Content-Range')).toBe(
			`bytes 2-6/${BYTES.length}`
		);
		expect(response.headers.get('Content-Length')).toBe('5');
	});

	it('serves an open-ended range to the end of the object', async () => {
		const response = await call(await signed(), {
			headers: { range: 'bytes=30-' },
		});
		expect(response.status).toBe(206);
		expect(await response.text()).toBe(BYTES.slice(30));
		expect(response.headers.get('Content-Range')).toBe(
			`bytes 30-${BYTES.length - 1}/${BYTES.length}`
		);
	});

	// The first thing a PDF reader asks for is the end of the file, where the
	// table of contents is.
	it('serves a suffix range, which is where a PDF keeps its index', async () => {
		const response = await call(await signed(), {
			headers: { range: 'bytes=-8' },
		});
		expect(response.status).toBe(206);
		expect(await response.text()).toBe(BYTES.slice(-8));
		expect(response.headers.get('Content-Range')).toBe(
			`bytes ${BYTES.length - 8}-${BYTES.length - 1}/${BYTES.length}`
		);
	});

	it('stops at the end of the object when asked for more than there is', async () => {
		const response = await call(await signed(), {
			headers: { range: 'bytes=30-9999' },
		});
		expect(response.status).toBe(206);
		expect(await response.text()).toBe(BYTES.slice(30));
		expect(response.headers.get('Content-Range')).toBe(
			`bytes 30-${BYTES.length - 1}/${BYTES.length}`
		);
		expect(response.headers.get('Content-Length')).toBe(
			String(BYTES.length - 30)
		);
	});

	it('gives the whole object when the range makes no sense', async () => {
		const response = await call(await signed(), {
			headers: { range: 'pages=1-2' },
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(BYTES);
	});
});

/**
 * A filename with a space arrives percent-encoded. The token was minted over
 * the key itself and R2 holds the key itself, so a route comparing the encoded
 * path failed the signature check and served nothing — for every work whose
 * file has a space or a comma in its name.
 */
describe('a key that has to be encoded to travel', () => {
	it('is signed, requested and served as the same key', async () => {
		const token = await signFileToken({ key: SPACED, secret: SECRET });
		const response = await call(
			`/api/files/${inUrl(SPACED)}?token=${encodeURIComponent(token)}`
		);
		expect(response.status).toBe(200);
		expect(reads).toEqual([SPACED]);
	});

	it('still refuses a token minted for a different object', async () => {
		const token = await signFileToken({ key: KEY, secret: SECRET });
		const response = await call(
			`/api/files/${inUrl(SPACED)}?token=${encodeURIComponent(token)}`
		);
		expect(response.status).toBe(401);
		expect(reads).toEqual([]);
	});
});
