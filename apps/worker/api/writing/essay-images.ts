import { Hono } from 'hono';
import type { Env, AuthContext } from '@alexandria/core';
import { friendlyZodError } from '@alexandria/core/platform';
import {
	EssayImagePatch,
	createEssayImage,
	getEssayImageById,
	updateEssayImage,
	deleteEssayImage,
} from '@alexandria/core/writing';
import { requireAuth } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// POST /upload/essay-image — image upload for inline essay embeds.
// Writes the file to R2 under `essays/images/{id}-{name}` and inserts a row
// in `essay_images` so the [[image:UUID]] token can resolve to a path,
// caption, and source URL.
//
// Form fields: file (required), id, caption, source_url. The id is the
// token UUID — pass it client-side so the editor can insert the token
// before the upload settles.
app.post('/upload/essay-image', requireAuth(), async (c) => {
	const bucket = c.env.R2_BUCKET;
	if (!bucket) {
		return c.json({ error: 'R2 bucket not configured' }, 500);
	}
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	try {
		const formData = await c.req.formData();
		const fileEntry = formData.get('file');
		if (!fileEntry || typeof fileEntry === 'string') {
			return c.json({ error: 'No file provided' }, 400);
		}

		const file = fileEntry as unknown as File;
		const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
		if (!file.type || !allowed.includes(file.type)) {
			return c.json(
				{ error: 'File must be a JPEG, PNG, WebP, or GIF image' },
				400
			);
		}

		const idEntry = formData.get('id');
		const id =
			typeof idEntry === 'string' && idEntry
				? idEntry
				: crypto.randomUUID();
		const captionEntry = formData.get('caption');
		const sourceEntry = formData.get('source_url');
		const caption =
			typeof captionEntry === 'string' && captionEntry
				? captionEntry
				: undefined;
		const source_url =
			typeof sourceEntry === 'string' && sourceEntry
				? sourceEntry
				: undefined;

		const filename = `essays/images/${id}-${file.name}`;
		await bucket.put(filename, file.stream(), {
			httpMetadata: { contentType: file.type },
		});

		const userId = c.get('authContext')!.user.id;
		const row = await createEssayImage(
			db,
			{
				id,
				path: filename,
				mime_type: file.type,
				caption,
				source_url,
			},
			userId
		);

		return c.json({
			ok: true,
			id: row.id,
			path: row.path,
			url: `/files/${row.path}`,
			image: row,
		});
	} catch (error) {
		console.error('POST /upload/essay-image error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// PATCH /essay-images/:id — update caption / source_url
app.patch('/essay-images/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}
	const id = c.req.param('id');

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const parsed = EssayImagePatch.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{
				error: 'Validation failed',
				details: friendlyZodError(parsed.error),
			},
			400
		);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		await updateEssayImage(db, id, parsed.data, userId);
		const row = await getEssayImageById(db, id, userId);
		if (!row) return c.json({ error: 'Image not found' }, 404);
		return c.json({ ok: true, image: row });
	} catch (error) {
		console.error('PATCH /essay-images/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// DELETE /essay-images/:id — also remove R2 object
app.delete('/essay-images/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}
	const id = c.req.param('id');

	try {
		const userId = c.get('authContext')!.user.id;
		const existing = await getEssayImageById(db, id, userId);
		if (!existing) return c.json({ error: 'Image not found' }, 404);

		await deleteEssayImage(db, id, userId);
		const bucket = c.env.R2_BUCKET;
		if (bucket && existing.path) {
			try {
				await bucket.delete(existing.path);
			} catch (r2err) {
				console.error('R2 delete failed:', r2err);
			}
		}
		return c.json({ ok: true });
	} catch (error) {
		console.error('DELETE /essay-images/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
