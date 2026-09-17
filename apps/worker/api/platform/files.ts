import { Hono } from 'hono';
import type { Env, AuthContext } from '@alexandria/core';
import {
	DEFAULT_FILE_TOKEN_TTL_SECONDS,
	InvalidObjectKeyError,
	signFileToken,
} from '@alexandria/core/platform';
import { requireAuth } from '../auth.js';
import { objectKeyFromPath } from './file-access.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// POST /files/sign — mint a signed URL token for one object key
app.post('/files/sign', requireAuth(), async (c) => {
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

/**
 * Serves one R2 object. Reached either with a session or with a signed token —
 * whichever it was, auth already happened in sessionMiddleware, so by here the
 * request is entitled to the object.
 */
const handleFileRequest = async (c: {
	env: Env;
	req: { path: string };
	json: (body: unknown, status?: number) => Response;
}) => {
	const bucket = c.env.R2_BUCKET;
	if (!bucket) {
		return c.json({ error: 'R2 bucket not configured' }, 500);
	}

	const key = objectKeyFromPath(c.req.path);
	if (key === null) {
		return c.json({ error: 'File not found' }, 404);
	}

	try {
		const object = await bucket.get(key);
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

		return new Response(object.body, { headers });
	} catch (error) {
		console.error('GET /files/* error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
};

app.get('/files/*', handleFileRequest);
app.get('/api/files/*', handleFileRequest);

export default app;
