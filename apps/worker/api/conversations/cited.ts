import { Hono } from 'hono';
import type { AuthContext, Env } from '@alexandria/core/platform';
import { entitlementFor, PAGE_SCANS } from '@alexandria/core/platform';
import { isCitedForReader } from '@alexandria/core/conversations';
import { isViewable, readPages, viewPage } from '@alexandria/core/works';
import { requireAuth } from '../auth.js';

/**
 * The pages a reader's own citations point at: the text on every plan, the
 * scan on Paid, one page at a time.
 *
 * Nothing else a reader can reach serves the library. The whole file and any
 * page on request are the admin's (`/files/*`, `/documents/:id/pages`); here a
 * page is served only when a citation the reader was given lies within a page
 * of it, so the most anyone can read is what their questions cited.
 */
const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

app.use('/cited/*', requireAuth());

type Ctx = { get(key: 'authContext'): AuthContext };

const isAdmin = (c: Ctx) => c.get('authContext').role === 'admin';

const pageNumber = (raw: string | undefined) => {
	const n = Number(raw);
	return Number.isInteger(n) && n >= 1 ? n : null;
};

const notCited = {
	error: 'That page is not one your conversations cited.',
	code: 'PAGE_NOT_CITED',
} as const;

// GET /cited/:document_id/pages?from=&to= — extracted text, at most five pages
app.get('/cited/:document_id/pages', async (c) => {
	const documentId = c.req.param('document_id');
	const from = pageNumber(c.req.query('from'));
	const to =
		c.req.query('to') === undefined ? from : pageNumber(c.req.query('to'));
	if (from === null || to === null || to < from) {
		return c.json({ error: 'from and to must be page numbers' }, 400);
	}

	if (
		!isAdmin(c) &&
		!(await isCitedForReader(
			c.env.DB,
			c.get('authContext').user.id,
			documentId,
			from,
			to
		))
	) {
		return c.json(notCited, 403);
	}

	const pages = await readPages(c.env.DB, {
		document_id: documentId,
		from,
		to,
	});
	return c.json({ pages });
});

/** Where a page cut out of a PDF is kept, so the file is sliced once, not per view. */
const sliceKey = (documentId: string, pageNo: number) =>
	`page-scans/${documentId}/${pageNo}.pdf`;

// GET /cited/:document_id/pages/:page_no/scan — the page itself, on Paid
app.get('/cited/:document_id/pages/:page_no/scan', async (c) => {
	const documentId = c.req.param('document_id');
	const pageNo = pageNumber(c.req.param('page_no'));
	if (pageNo === null) return c.json({ error: 'Not a page number' }, 400);

	const { user, role } = c.get('authContext');
	if (role !== 'admin') {
		const entitlement = await entitlementFor(c.env.DB, user.id, role);
		if (!PAGE_SCANS[entitlement.plan]) {
			return c.json(
				{
					error: 'The scan of a cited page is part of Paid.',
					code: 'SCAN_REQUIRES_PAID',
				},
				403
			);
		}
		if (
			!(await isCitedForReader(
				c.env.DB,
				user.id,
				documentId,
				pageNo,
				pageNo
			))
		) {
			return c.json(notCited, 403);
		}
	}

	const bucket = c.env.R2_BUCKET;
	const kept = bucket ? await bucket.get(sliceKey(documentId, pageNo)) : null;
	if (kept) return scanResponse(kept.body, 'application/pdf');

	const view = await viewPage(
		{ DB: c.env.DB, R2_BUCKET: bucket },
		{ document_id: documentId, page_no: pageNo }
	);
	if (!isViewable(view)) {
		return c.json(
			{
				error: 'There is no scan of this page to show yet.',
				code: 'SCAN_UNAVAILABLE',
				reason: view.reason,
			},
			404
		);
	}

	// Only a slice is kept; a rendered image is already its own object.
	if (bucket && view.media_type === 'application/pdf') {
		await bucket.put(sliceKey(documentId, pageNo), view.data, {
			httpMetadata: { contentType: 'application/pdf' },
		});
	}
	return scanResponse(view.data, view.media_type);
});

function scanResponse(body: BodyInit, contentType: string) {
	return new Response(body, {
		headers: {
			'Content-Type': contentType,
			// One reader's page: a shared cache must not hand it to the next.
			'Cache-Control': 'private, max-age=86400',
		},
	});
}

export default app;
