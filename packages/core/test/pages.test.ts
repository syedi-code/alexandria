import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
	createTestDatabase,
	searchTestDatabase,
	type TestDatabase,
} from './d1.js';
import { catalogueTestDatabase, ids } from './fixture.js';
import {
	checkQuote,
	documentObjectKey,
	estimateTextLayerRows,
	getDocumentDetail,
	indexDocumentPages,
	isViewable,
	listDocuments,
	listIndexedDocuments,
	listPageTexts,
	listReadableWorks,
	normalizeForMatching,
	readPages,
	searchPages,
	slicePdfPage,
	TEXT_LAYER_MODEL,
	toMatchExpression,
	ToolUnavailableError,
	verifyCitation,
	verifyCitations,
	viewPage,
	worksTools,
	writeTextLayer,
} from '../works/index.js';
import { insertRows, D1_MAX_BOUND_PARAMETERS } from '../platform/index.js';

const BGE_PAGES = [
	null,
	'BEYOND GOOD AND EVIL\nPrelude to a Philosophy of the Future, and of the Übermensch',
	'The Will to Truth, which is to tempt us to many a hazardous enterprise, the famous\nTruthfulness of which all philosophers have hitherto spoken with respect,\nwhat questions has this Will to Truth not laid before us!',
	'What in us really wants "Truth"? Indeed we made a long halt at the question as to\nthe origin of this Will — until at last we came to an absolute standstill\nbefore a yet more fundamental question. We inquired about the value of this\nWill. Granted that we want the truth: why not rather untruth? And uncer-\ntainty? Even ignorance? The problem of the value of truth presented itself\nbefore us — or was it we who presented ourselves before the problem? Which of\nus is the Œdipus here?',
	'It is almost incredible that these questions for which the ground has been\nprepared by the long discipline of the free spirit could be answered in\nthe spirit of ressentiment, the moral valuation that says',
	'BEYOND GOOD AND EVIL 5\nno to what is outside, to what is different, to what is not itself;\nand this No is its creative deed.',
];

let db: TestDatabase;
let search: TestDatabase;
let bgeDocumentId: string;
let gsDocumentId: string;

async function primaryDocument(workId: string): Promise<string> {
	const [document] = await listDocuments(db.d1, workId);
	return document.id;
}

beforeEach(async () => {
	db = catalogueTestDatabase();
	search = searchTestDatabase();
	bgeDocumentId = await primaryDocument(ids.bookBeyondGoodAndEvil);
	gsDocumentId = await primaryDocument(ids.bookGayScience);
});

afterEach(() => {
	db.close();
	search.close();
});

async function extractBge() {
	return writeTextLayer(db.d1, {
		documentId: bgeDocumentId,
		extractor: 'unpdf@test',
		pages: BGE_PAGES,
	});
}

describe('insertRows', () => {
	it('never binds more than D1 allows in one statement', () => {
		const rows = Array.from({ length: 100 }, (_, i) => ['t', i, 'text']);
		const statements = insertRows('pages', ['a', 'b', 'c'], rows);
		expect(statements.length).toBe(4);
		for (const { params } of statements) {
			expect(params.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
		}
		expect(statements.flatMap((s) => s.params)).toEqual(rows.flat());
	});

	it('splits on payload size before the parameter limit', () => {
		const page = 'x'.repeat(30_000);
		const statements = insertRows(
			'pages',
			['text'],
			[[page], [page], [page]]
		);
		expect(statements.map((s) => s.params.length)).toEqual([2, 1]);
	});
});

describe('documentObjectKey', () => {
	it.each([
		['/files/books/uploads/a.pdf', 'books/uploads/a.pdf'],
		['/api/files/books/a.pdf', 'books/a.pdf'],
		['books/bge/bge.pdf', 'books/bge/bge.pdf'],
	])('%s → %s', (stored, key) => {
		expect(documentObjectKey(stored)).toBe(key);
	});
});

describe('the text layer', () => {
	it('stores one page row per PDF page and makes the transcription current', async () => {
		const { transcriptionId, rowsWritten } = await extractBge();

		const document = db.raw
			.prepare(
				`SELECT current_transcription_id, page_count FROM documents WHERE id = ?`
			)
			.get(bgeDocumentId) as {
			current_transcription_id: string;
			page_count: number;
		};
		expect(document).toEqual({
			current_transcription_id: transcriptionId,
			page_count: BGE_PAGES.length,
		});

		const transcription = db.raw
			.prepare(
				`SELECT model, prompt_version, status FROM transcriptions WHERE id = ?`
			)
			.get(transcriptionId);
		expect({ ...transcription }).toEqual({
			model: TEXT_LAYER_MODEL,
			prompt_version: 'unpdf@test',
			status: 'complete',
		});
		expect(rowsWritten).toBeGreaterThan(0);
	});

	it('stores a blank page as null rather than dropping it', async () => {
		await extractBge();
		const [first] = await readPages(db.d1, {
			document_id: bgeDocumentId,
			from: 1,
		});
		expect(first.text).toBeNull();
	});

	it('replaces an earlier extraction instead of duplicating it', async () => {
		await extractBge();
		const { transcriptionId } = await extractBge();

		const counts = db.raw
			.prepare(
				`SELECT (SELECT COUNT(*) FROM transcriptions WHERE document_id = ?) AS transcriptions,
				        (SELECT COUNT(*) FROM pages) AS pages`
			)
			.get(bgeDocumentId) as { transcriptions: number; pages: number };
		expect(counts).toEqual({ transcriptions: 1, pages: BGE_PAGES.length });
		expect(
			(await listPageTexts(db.d1, bgeDocumentId))?.transcription_id
		).toBe(transcriptionId);
	});

	it('never demotes a different transcription that is already current', async () => {
		db.raw
			.prepare(
				`INSERT INTO transcriptions (id, document_id, model, status, created_at, updated_at)
				 VALUES ('llm', ?, 'some-vision-model', 'complete', 'now', 'now')`
			)
			.run(bgeDocumentId);
		db.raw
			.prepare(
				`UPDATE documents SET current_transcription_id = 'llm' WHERE id = ?`
			)
			.run(bgeDocumentId);

		await extractBge();

		const { current_transcription_id } = db.raw
			.prepare(
				`SELECT current_transcription_id FROM documents WHERE id = ?`
			)
			.get(bgeDocumentId) as { current_transcription_id: string };
		expect(current_transcription_id).toBe('llm');
	});

	it('estimates the rows D1 will bill', () => {
		expect(estimateTextLayerRows(300)).toBe(1208);
	});
});

describe('reading pages', () => {
	beforeEach(extractBge);

	it('names each page by work, creator and printed page', async () => {
		db.raw
			.prepare(`UPDATE documents SET page_offset = 2 WHERE id = ?`)
			.run(bgeDocumentId);
		const pages = await readPages(db.d1, {
			document_id: bgeDocumentId,
			from: 2,
			to: 3,
		});

		expect(pages.map((p) => [p.ref.page_no, p.printed_page])).toEqual([
			[2, null],
			[3, '1'],
		]);
		expect(pages[0]).toMatchObject({
			work_title: 'Beyond Good and Evil',
			creator: 'Friedrich Nietzsche',
		});
	});

	it('caps a read at five pages', async () => {
		const pages = await readPages(db.d1, {
			document_id: bgeDocumentId,
			from: 1,
			to: 50,
		});
		expect(pages.map((p) => p.ref.page_no)).toEqual([1, 2, 3, 4, 5]);
	});
});

describe('page search', () => {
	beforeEach(async () => {
		const { transcriptionId } = await extractBge();
		const texts = await listPageTexts(db.d1, bgeDocumentId);
		await indexDocumentPages(search.d1, {
			documentId: bgeDocumentId,
			transcriptionId,
			pages: texts!.pages,
		});
	});

	it('turns hostile input into a valid expression', () => {
		expect(toMatchExpression('will to "truth" AND NOT) (* "unclosed')).toBe(
			'"truth" OR "will" OR "to" OR "unclosed"'
		);
		expect(toMatchExpression('()*:')).toBeNull();
	});

	it('finds pages, ranks the better match first, and marks the terms', async () => {
		const hits = await searchPages(search.d1, db.d1, {
			query: '"will to truth" value',
		});

		expect(hits[0].ref).toEqual({ document_id: bgeDocumentId, page_no: 3 });
		expect(hits.map((h) => h.ref.page_no)).toContain(4);
		expect(hits[0].snippet).toContain('«');
		expect(hits[0].work_title).toBe('Beyond Good and Evil');
	});

	it('matches regardless of diacritics', async () => {
		const hits = await searchPages(search.d1, db.d1, {
			query: 'ubermensch',
		});
		expect(hits.map((h) => h.ref.page_no)).toEqual([2]);
	});

	it('scopes to works', async () => {
		expect(
			await searchPages(search.d1, db.d1, {
				query: 'truth',
				work_ids: [ids.bookGayScience],
			})
		).toEqual([]);
	});

	it('says the index is unbuilt rather than reporting no matches', async () => {
		const empty = searchTestDatabase();
		await expect(
			searchPages(empty.d1, db.d1, { query: 'truth' })
		).rejects.toBeInstanceOf(ToolUnavailableError);
		empty.close();
	});

	it('says the same when the index was never created at all', async () => {
		const missing = createTestDatabase();
		await expect(
			searchPages(missing.d1, db.d1, { query: 'truth' })
		).rejects.toThrow(/has not been built/);
		missing.close();
	});

	it('reports no matches once something is indexed', async () => {
		expect(
			await searchPages(search.d1, db.d1, { query: 'bureaucracy' })
		).toEqual([]);
	});

	it('replaces a document’s rows on reindex and records what it was built from', async () => {
		await indexDocumentPages(search.d1, {
			documentId: bgeDocumentId,
			transcriptionId: 'newer',
			pages: [{ page_no: 1, text: 'only this' }],
		});

		expect(await searchPages(search.d1, db.d1, { query: 'truth' })).toEqual(
			[]
		);
		expect(await listIndexedDocuments(search.d1)).toEqual(
			new Map([[bgeDocumentId, 'newer']])
		);
	});
});

describe('citation verification', () => {
	beforeEach(extractBge);

	const ref = (page_no: number) => ({ document_id: bgeDocumentId, page_no });

	it('normalises what PDFs do to text', () => {
		expect(
			normalizeForMatching('Œdipus — “uncer-\ntainty”, self-deception')
		).toBe('oedipus uncertainty selfdeception');
	});

	it('verifies a quote whatever the punctuation and line breaks', async () => {
		expect(
			await verifyCitation(db.d1, {
				ref: ref(4),
				quote: 'Granted that we want the truth: why not rather untruth? And uncertainty?',
			})
		).toEqual({ status: 'verified', matched: [ref(4)] });
	});

	it('verifies a quote that runs onto the next page past its running header', async () => {
		expect(
			await verifyCitation(db.d1, {
				ref: ref(5),
				quote: 'the moral valuation that says no to what is outside, to what is different',
			})
		).toEqual({ status: 'verified', matched: [ref(5), ref(6)] });
	});

	it('rejects words the page does not contain', async () => {
		expect(
			await verifyCitation(db.d1, {
				ref: ref(4),
				quote: 'Granted that we want the truth: why not rather beauty?',
			})
		).toEqual({ status: 'unverified', reason: 'not_found' });
	});

	it('does not accept a quote too short to be evidence', async () => {
		expect(
			await verifyCitation(db.d1, { ref: ref(4), quote: 'the truth' })
		).toEqual({
			status: 'unverified',
			reason: 'quote_too_short',
		});
	});

	it('distinguishes a page that does not exist from one that has no text', async () => {
		const [missing, blank] = await verifyCitations(db.d1, [
			{ ref: ref(99), quote: 'any quote at all that is long' },
			{ ref: ref(1), quote: 'any quote at all that is long' },
		]);
		expect(missing).toEqual({
			status: 'unverified',
			reason: 'no_such_page',
		});
		expect(blank).toEqual({
			status: 'unverifiable',
			reason: 'no_text_layer',
		});
	});

	const onPage = (text: string) => ({
		ref: ref(1),
		work_id: 'w',
		work_title: 't',
		creator: 'c',
		printed_page: null,
		text,
	});

	it('reads a hyphen between words as a dash when that is what it was', () => {
		const page = onPage(
			'claims that his own is based on\nthe firmest rationalism-their barbaric repudiation, for the sake of'
		);
		const status = (quote: string) => checkQuote(quote, page).status;

		expect(status('their barbaric repudiation, for the sake of')).toBe(
			'verified'
		);
		expect(
			status('the firmest rationalism—their barbaric repudiation')
		).toBe('verified');
	});

	it('verifies a quote with words left out, if every part is there in order', () => {
		const page = onPage(
			'each of these gentlemen, in order to impugn on higher authority the weakness of primitive thought, claims that his own is based on the firmest rationalism'
		);
		const status = (quote: string) => checkQuote(quote, page).status;

		expect(
			status('each of these gentlemen... claims that his own is based')
		).toBe('verified');
		expect(
			status('each of these gentlemen … the firmest rationalism')
		).toBe('verified');
		expect(
			status('claims that his own is based . . . each of these gentlemen')
		).toBe('unverified');
		expect(
			status('each of these gentlemen... claims... firmest rationalism')
		).toBe('unverified');
		expect(
			status('each of these gentlemen... claims that his own is sound')
		).toBe('unverified');
	});

	it('does not match inside a longer word', () => {
		const page = {
			ref: ref(1),
			work_id: 'w',
			work_title: 't',
			creator: 'c',
			printed_page: null,
			text: 'the untruthful and the untrue are not the truthful',
		};
		expect(checkQuote('truthful and the untrue are not', page).status).toBe(
			'unverified'
		);
	});
});

describe('readable works', () => {
	it('lists only works with documents, and says whether each can be searched', async () => {
		await extractBge();
		const works = await listReadableWorks(db.d1);

		expect(works.map((w) => w.title)).toEqual([
			'Beyond Good and Evil',
			'The Gay Science',
		]);
		expect(works[0].documents).toEqual([
			expect.objectContaining({
				document_id: bgeDocumentId,
				text: 'searchable',
				page_count: 6,
			}),
		]);
		expect(works[1].documents[0].text).toBe('not_extracted');
	});

	it('calls an extracted document with no text a scan', async () => {
		await writeTextLayer(db.d1, {
			documentId: gsDocumentId,
			extractor: 'unpdf@test',
			pages: [null, '  '],
		});
		const [work] = await listReadableWorks(db.d1, { filter: 'gay' });
		expect(work.documents[0].text).toBe('scan');
	});

	it('filters on every word, across title and creator', async () => {
		const titles = async (filter: string) =>
			(await listReadableWorks(db.d1, { filter })).map((w) => w.title);
		expect(await titles('nietzsche gay')).toEqual(['The Gay Science']);
		expect(await titles('  Beyond   Nietzsche ')).toEqual([
			'Beyond Good and Evil',
		]);
		expect(await titles('nietzsche kant')).toEqual([]);
	});

	it('gives the bucket key for a document, never the stored URL path', async () => {
		db.raw
			.prepare(
				`UPDATE documents SET r2_key = '/files/books/bge/bge.pdf' WHERE id = ?`
			)
			.run(bgeDocumentId);
		expect((await getDocumentDetail(db.d1, bgeDocumentId))?.file_key).toBe(
			'books/bge/bge.pdf'
		);
	});
});

describe('viewing a page', () => {
	async function threePagePdf(): Promise<Uint8Array> {
		const pdf = await PDFDocument.create();
		for (let i = 0; i < 3; i++) pdf.addPage([200 + i, 300]);
		return pdf.save();
	}

	function bucket(objects: Record<string, Uint8Array>) {
		const object = (key: string) =>
			objects[key] && {
				size: objects[key].byteLength,
				httpMetadata: {},
				arrayBuffer: async () => objects[key].buffer,
			};
		return {
			head: async (key: string) => object(key) ?? null,
			get: async (key: string) => object(key) ?? null,
		} as unknown as R2Bucket;
	}

	it('cuts one page out of a PDF', async () => {
		const view = await slicePdfPage(await threePagePdf(), 2);
		if (!isViewable(view)) throw new Error(view.reason);
		const single = await PDFDocument.load(view.data);
		expect(single.getPageCount()).toBe(1);
		expect(single.getPage(0).getWidth()).toBe(201);
	});

	it('reads the file through the normalised key', async () => {
		db.raw
			.prepare(
				`UPDATE documents SET r2_key = '/files/books/bge/bge.pdf' WHERE id = ?`
			)
			.run(bgeDocumentId);
		const view = await viewPage(
			{
				DB: db.d1,
				R2_BUCKET: bucket({
					'books/bge/bge.pdf': await threePagePdf(),
				}),
			},
			{ document_id: bgeDocumentId, page_no: 3 }
		);
		expect(view).toMatchObject({ ok: true, media_type: 'application/pdf' });
	});

	it('refuses a page past the end', async () => {
		const view = await viewPage(
			{
				DB: db.d1,
				R2_BUCKET: bucket({
					'books/bge/bge.pdf': await threePagePdf(),
				}),
			},
			{ document_id: bgeDocumentId, page_no: 4 }
		);
		expect(view).toEqual({ ok: false, reason: 'no_such_page' });
	});
});

describe('works tools', () => {
	it('validate their input', () => {
		expect(
			worksTools.read_pages.input.safeParse({ document_id: 'd', from: 0 })
				.success
		).toBe(false);
		expect(
			worksTools.verify_citation.input.safeParse({
				document_id: 'd',
				page_no: 2,
				quote: 'x',
			}).success
		).toBe(true);
	});

	it('report search as unavailable without the search database', async () => {
		await expect(
			worksTools.search_pages.run({ db: db.d1 }, { query: 'truth' })
		).rejects.toBeInstanceOf(ToolUnavailableError);
	});
});
