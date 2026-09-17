import { Hono } from 'hono';
import type { Env, AuthContext } from '@alexandria/core/platform';
import { adminOnlyMiddleware } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// POST /upload/pdf
app.post('/upload/pdf', adminOnlyMiddleware(), async (c) => {
	const bucket = c.env.R2_BUCKET;
	if (!bucket) {
		return c.json({ error: 'R2 bucket not configured' }, 500);
	}

	try {
		const formData = await c.req.formData();
		const fileEntry = formData.get('file');
		const bookId = formData.get('bookId');

		// Type guard for File vs string
		if (!fileEntry || typeof fileEntry === 'string') {
			return c.json({ error: 'No file provided' }, 400);
		}

		const file = fileEntry as unknown as File;

		if (!file.type || !file.type.includes('pdf')) {
			return c.json({ error: 'File must be a PDF' }, 400);
		}

		// Generate unique filename
		const bookIdStr = typeof bookId === 'string' ? bookId : null;
		const filename = bookIdStr
			? `books/${bookIdStr}/${file.name}`
			: `books/uploads/${crypto.randomUUID()}-${file.name}`;

		// Upload to R2
		await bucket.put(filename, file.stream(), {
			httpMetadata: {
				contentType: 'application/pdf',
			},
		});

		// Return the path (frontend can construct full URL)
		return c.json({
			ok: true,
			path: filename,
			url: `/files/${filename}`,
		});
	} catch (error) {
		console.error('POST /upload/pdf error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /upload/cover — image upload for book covers (JPEG/PNG/WebP).
// Mirrors /upload/pdf: same R2 bucket, same path scheme under books/.
app.post('/upload/cover', adminOnlyMiddleware(), async (c) => {
	const bucket = c.env.R2_BUCKET;
	if (!bucket) {
		return c.json({ error: 'R2 bucket not configured' }, 500);
	}

	try {
		const formData = await c.req.formData();
		const fileEntry = formData.get('file');
		const bookId = formData.get('bookId');

		if (!fileEntry || typeof fileEntry === 'string') {
			return c.json({ error: 'No file provided' }, 400);
		}

		const file = fileEntry as unknown as File;

		const allowed = ['image/jpeg', 'image/png', 'image/webp'];
		if (!file.type || !allowed.includes(file.type)) {
			return c.json(
				{ error: 'File must be a JPEG, PNG, or WebP image' },
				400
			);
		}

		const bookIdStr = typeof bookId === 'string' ? bookId : null;
		const filename = bookIdStr
			? `books/${bookIdStr}/cover-${file.name}`
			: `books/uploads/cover-${crypto.randomUUID()}-${file.name}`;

		await bucket.put(filename, file.stream(), {
			httpMetadata: {
				contentType: file.type,
			},
		});

		return c.json({
			ok: true,
			path: filename,
			url: `/files/${filename}`,
		});
	} catch (error) {
		console.error('POST /upload/cover error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /upload/book-media — image upload for book gallery (JPEG/PNG/WebP).
// Returns { ok, path }; caller then POSTs /books/:id/media to register it.
app.post('/upload/book-media', adminOnlyMiddleware(), async (c) => {
	const bucket = c.env.R2_BUCKET;
	if (!bucket) {
		return c.json({ error: 'R2 bucket not configured' }, 500);
	}

	try {
		const formData = await c.req.formData();
		const fileEntry = formData.get('file');
		const bookId = formData.get('bookId');

		if (!fileEntry || typeof fileEntry === 'string') {
			return c.json({ error: 'No file provided' }, 400);
		}

		const file = fileEntry as unknown as File;
		const allowed = ['image/jpeg', 'image/png', 'image/webp'];
		if (!file.type || !allowed.includes(file.type)) {
			return c.json(
				{ error: 'File must be a JPEG, PNG, or WebP image' },
				400
			);
		}

		const bookIdStr = typeof bookId === 'string' ? bookId : null;
		if (!bookIdStr) {
			return c.json({ error: 'bookId is required' }, 400);
		}

		const filename = `books/${bookIdStr}/media/${crypto.randomUUID()}-${file.name}`;
		await bucket.put(filename, file.stream(), {
			httpMetadata: { contentType: file.type },
		});

		return c.json({
			ok: true,
			path: filename,
			url: `/files/${filename}`,
		});
	} catch (error) {
		console.error('POST /upload/book-media error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
