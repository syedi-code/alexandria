import { Hono } from 'hono';
import type { Env, AuthContext } from '@alexandria/core';
import {
	DEFAULT_FILE_TOKEN_TTL_SECONDS,
	InvalidObjectKeyError,
	signFileToken,
} from '@alexandria/core/platform';
import { adminOnlyMiddleware, requireAuth } from '../auth.js';
import { objectKeyFromPath } from './file-access.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// POST /files/sign — mint a signed URL token for one object key. The admin's
// alone: a token opens the whole file, and a reader is given the page a
// citation points at (`/cited/...`), never the book.
app.post('/files/sign', requireAuth(), adminOnlyMiddleware(), async (c) => {
	const secret = c.env.FILE_SIGNING_SECRET;
	if (!secret) {
		return c.json({ error: 'File signing secret not configured' }, 500);
	}

	let body: { path?: unknown; expiresIn?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	if (!body.path) {
		return c.json({ error: 'Path is required' }, 400);
	}

	try {
		const token = await signFileToken({
			key: body.path as string,
			secret,
			expiresInSeconds:
				typeof body.expiresIn === 'number'
					? body.expiresIn
					: DEFAULT_FILE_TOKEN_TTL_SECONDS,
		});
		return c.json({ token });
	} catch (error) {
		if (error instanceof InvalidObjectKeyError) {
			return c.json({ error: 'Invalid file path' }, 400);
		}
		throw error;
	}
});

const RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * What a `Range:` header asks for, in R2's terms, or null for the whole
 * object. Anything malformed is treated as no range at all, which is what the
 * spec asks for: a reader that cannot be given the part it wanted is given
 * the whole rather than an error.
 */
function rangeOf(header: string | undefined): R2Range | null {
	const asked = header ? RANGE.exec(header.trim()) : null;
	if (!asked) return null;
	const [, from, to] = asked;
	if (from === '') return to === '' ? null : { suffix: Number(to) };
	const offset = Number(from);
	return to === '' ? { offset } : { offset, length: Number(to) - offset + 1 };
}

/**
 * Serves one R2 object. Reached either with a signed token or with the admin's
 * session. Only the admin can mint a token, and a reader's session is refused
 * here, because a session that opens any key opens the whole library.
 *
 * It answers byte ranges, and says so. A reader who wants page 147 of a
 * four-hundred-page scan should not be sent the other three hundred and
 * ninety-nine: without `Accept-Ranges` a PDF reader has no way to ask for less
 * and pulls the whole file — measurably, the whole file several times over —
 * which on a phone is the difference between a page appearing and nothing
 * appearing at all. R2 does the seeking, so this costs I/O and no CPU.
 */
const handleFileRequest = async (c: {
	env: Env;
	req: { path: string; header(name: string): string | undefined };
	json: (body: unknown, status?: number) => Response;
	get(key: 'authContext'): AuthContext | undefined;
}) => {
	// A signed request carries no authContext; sessionMiddleware verified it.
	const session = c.get('authContext');
	if (session && session.role !== 'admin') {
		return c.json({ error: 'Admin access required' }, 403);
	}

	const bucket = c.env.R2_BUCKET;
	if (!bucket) {
		return c.json({ error: 'R2 bucket not configured' }, 500);
	}

	const key = objectKeyFromPath(c.req.path);
	if (key === null) {
		return c.json({ error: 'File not found' }, 404);
	}

	try {
		const wanted = rangeOf(c.req.header('range'));
		const object = await bucket.get(key, wanted ? { range: wanted } : {});
		if (!object) {
			return c.json({ error: 'File not found' }, 404);
		}

		const headers = new Headers();
		headers.set(
			'Content-Type',
			object.httpMetadata?.contentType || 'application/octet-stream'
		);
		// Private: the URL is entitled to one viewer for an hour, so a shared
		// cache must not keep a copy to hand to the next request for it.
		headers.set('Cache-Control', 'private, max-age=3600');
		headers.set('Accept-Ranges', 'bytes');

		const served = wanted ? servedRange(object) : null;
		if (!served) {
			headers.set('Content-Length', String(object.size));
			return new Response(object.body, { headers });
		}

		headers.set('Content-Length', String(served.length));
		headers.set(
			'Content-Range',
			`bytes ${served.offset}-${served.offset + served.length - 1}/${object.size}`
		);
		return new Response(object.body, { status: 206, headers });
	} catch (error) {
		console.error('GET /files/* error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
};

/** Where R2 landed, once it has resolved an offset or a suffix against the object. */
function servedRange(
	object: R2Object
): { offset: number; length: number } | null {
	const range = object.range;
	if (!range) return null;
	if ('suffix' in range) {
		return {
			offset: Math.max(0, object.size - range.suffix),
			length: Math.min(range.suffix, object.size),
		};
	}
	// Clamped to the object, so the headers describe what is in the body even
	// when a reader asks for more than there is.
	const offset = Math.min(range.offset ?? 0, object.size);
	const rest = object.size - offset;
	return { offset, length: Math.min(range.length ?? rest, rest) };
}

app.get('/files/*', handleFileRequest);
app.get('/api/files/*', handleFileRequest);

export default app;
