import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import router from '../api/router.js';
import type { TestDatabase } from '../../../packages/core/test/d1.js';
import {
	catalogueTestDatabase,
	ids,
} from '../../../packages/core/test/fixture.js';
import { listDocuments, writeTextLayer } from '@alexandria/core/works';
import { signFileToken } from '@alexandria/core/platform';

const KEY = 'books/bge/bge.pdf';
const SECRET = 'file-signing-secret-for-tests';
const AT = '2026-09-01T00:00:00Z';

let db: TestDatabase;
let documentId: string;
let stored: Map<string, Uint8Array>;
let reads: string[];

async function tenPagePdf() {
	const pdf = await PDFDocument.create();
	for (let i = 0; i < 10; i++) pdf.addPage([200 + i, 300]);
	return pdf.save();
}

/** R2, as far as these routes use it: get, head and put, with reads recorded. */
const bucket = () =>
	({
		async get(key: string) {
			reads.push(key);
			const bytes = stored.get(key);
			if (!bytes) return null;
			return {
				body: bytes,
				size: bytes.length,
				httpMetadata: { contentType: 'application/pdf' },
				arrayBuffer: async () => bytes.slice().buffer,
			};
		},
		async head(key: string) {
			const bytes = stored.get(key);
			return bytes ? { size: bytes.length } : null;
		},
		async put(key: string, value: Uint8Array) {
			stored.set(key, value);
		},
	}) as unknown as R2Bucket;

function seedReader(id: string, role: 'member' | 'admin', plan = 'free') {
	db.raw
		.prepare(
			`INSERT INTO users (id, email, first_seen, last_seen, plan) VALUES (?, ?, ?, ?, ?)`
		)
		.run(id, `${id}@readers.test`, AT, AT, plan);
	db.raw
		.prepare(
			`INSERT INTO sessions (token, user_id, email, role, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(
			`t-${id}`,
			id,
			`${id}@readers.test`,
			role,
			AT,
			'2099-01-01T00:00:00Z'
		);
}

/** A conversation of this reader's with one answer citing this page. */
function cite(userId: string, pageNo: number) {
	const n = `${userId}-${pageNo}`;
	db.raw
		.prepare(
			`INSERT INTO conversations (id, user_id, model_id, created_at, updated_at)
			 VALUES (?, ?, 'gpt-5.6-luna', ?, ?)`
		)
		.run(`c-${n}`, userId, AT, AT);
	db.raw
		.prepare(
			`INSERT INTO messages (id, conversation_id, seq, role, parts, created_at)
			 VALUES (?, ?, 1, 'assistant', '[]', ?)`
		)
		.run(`m-${n}`, `c-${n}`, AT);
	db.raw
		.prepare(
			`INSERT INTO citations (id, message_id, document_id, page_no, quote, status, created_at)
			 VALUES (?, ?, ?, ?, 'some words', 'verified', ?)`
		)
		.run(`q-${n}`, `m-${n}`, documentId, pageNo, AT);
}

beforeEach(async () => {
	db = catalogueTestDatabase();
	[{ id: documentId }] = await listDocuments(
		db.d1,
		ids.bookBeyondGoodAndEvil
	);
	db.raw
		.prepare(`UPDATE documents SET r2_key = ? WHERE id = ?`)
		.run(KEY, documentId);
	await writeTextLayer(db.d1, {
		documentId,
		extractor: 'unpdf@test',
		pages: Array.from({ length: 10 }, (_, i) => `text of page ${i + 1}`),
	});
	stored = new Map([[KEY, await tenPagePdf()]]);
	reads = [];

	seedReader('free', 'member');
	seedReader('paid', 'member', 'paid');
	seedReader('admin', 'admin');
	cite('free', 5);
	cite('paid', 5);
});

afterEach(() => db.close());

const call = (path: string, reader: string, init: RequestInit = {}) =>
	router.fetch(
		new Request(`http://alexandria.test${path}`, {
			...init,
			headers: { cookie: reader ? `__session=t-${reader}` : '' },
		}),
		{
			DB: db.d1,
			R2_BUCKET: bucket(),
			FILE_SIGNING_SECRET: SECRET,
			ADMIN_EMAIL: 'admin@readers.test',
			LOCAL_DEV: 'false',
		}
	);

const scan = (reader: string, page: number) =>
	call(`/cited/${documentId}/pages/${page}/scan`, reader);

describe('GET /cited/:document_id/pages/:page_no/scan', () => {
	it('gives a paid reader the one page they cited, and only that page', async () => {
		const response = await scan('paid', 5);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/pdf');
		expect(response.headers.get('cache-control')).toMatch(/^private/);
		const page = await PDFDocument.load(
			new Uint8Array(await response.arrayBuffer())
		);
		expect(page.getPageCount()).toBe(1);
		expect(page.getPage(0).getWidth()).toBe(204);
	});

	it('reaches one page either side, for a quote that runs across the break', async () => {
		expect((await scan('paid', 4)).status).toBe(200);
		expect((await scan('paid', 6)).status).toBe(200);
	});

	it('refuses a page no citation of theirs points at, without reading the file', async () => {
		const response = await scan('paid', 8);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: 'PAGE_NOT_CITED' });
		expect(reads).not.toContain(KEY);
	});

	it("does not count another reader's citations", async () => {
		cite('free', 9);
		expect((await scan('paid', 9)).status).toBe(403);
	});

	it('is part of Paid', async () => {
		const response = await scan('free', 5);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			code: 'SCAN_REQUIRES_PAID',
		});
		expect(reads).not.toContain(KEY);
	});

	it('gives the admin any page', async () => {
		expect((await scan('admin', 8)).status).toBe(200);
	});

	it('slices a page once and keeps it', async () => {
		await scan('paid', 5);
		reads = [];
		expect((await scan('paid', 5)).status).toBe(200);
		expect(reads).toEqual([`page-scans/${documentId}/5.pdf`]);
	});

	it('says plainly when there is no scan to show', async () => {
		stored.delete(KEY);
		const response = await scan('paid', 5);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			code: 'SCAN_UNAVAILABLE',
		});
	});

	it('needs a session', async () => {
		expect((await scan('', 5)).status).toBe(401);
	});
});

describe('GET /cited/:document_id/pages', () => {
	const text = (reader: string, from: number, to = from) =>
		call(`/cited/${documentId}/pages?from=${from}&to=${to}`, reader);

	it('gives any reader the text around a page they cited', async () => {
		const response = await text('free', 4, 6);
		expect(response.status).toBe(200);
		const { pages } = (await response.json()) as {
			pages: { ref: { page_no: number } }[];
		};
		expect(pages.map((p) => p.ref.page_no)).toEqual([4, 5, 6]);
	});

	it('refuses a range that runs past what was cited', async () => {
		expect((await text('free', 4, 7)).status).toBe(403);
		expect((await text('free', 1)).status).toBe(403);
	});
});

describe('the whole file is the admin’s', () => {
	it('refuses to sign a file for a reader', async () => {
		const response = await call('/files/sign', 'paid', {
			method: 'POST',
			body: JSON.stringify({ path: KEY }),
		});
		expect(response.status).toBe(403);
	});

	it('refuses a file to a reader’s session, without reading it', async () => {
		expect((await call(`/api/files/${KEY}`, 'paid')).status).toBe(403);
		expect(reads).not.toContain(KEY);
	});

	it('still serves a signed file, and the admin’s session', async () => {
		const token = await signFileToken({ key: KEY, secret: SECRET });
		const signed = await call(
			`/api/files/${KEY}?token=${encodeURIComponent(token)}`,
			''
		);
		expect(signed.status).toBe(200);
		expect((await call(`/api/files/${KEY}`, 'admin')).status).toBe(200);
	});

	it('refuses any page of text on request to a reader', async () => {
		expect(
			(await call(`/documents/${documentId}/pages?from=5`, 'paid')).status
		).toBe(403);
		expect(
			(await call(`/documents/${documentId}/pages?from=5`, 'admin'))
				.status
		).toBe(200);
	});
});
