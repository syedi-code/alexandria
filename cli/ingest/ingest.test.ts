import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { textLayerStatements } from '@alexandria/core/works';
import {
	catalogueTestDatabase,
	ids,
} from '../../packages/core/test/fixture.js';
import { renderSqlFile, renderStatement } from './sql-file.js';
import { extractPageTexts } from './pdf-text.js';
import { RowBudget } from './run.js';

describe('rendering statements for wrangler', () => {
	const hostile = [
		"It's a '; DROP TABLE pages; -- trap",
		'Is this a placeholder? Or two?? \n\n New paragraph — «Übermensch»',
		null,
	];

	it('writes exactly what bound parameters would have written', () => {
		const db = catalogueTestDatabase();
		const document = db.raw
			.prepare(`SELECT id FROM documents WHERE work_id = ?`)
			.get(ids.bookBeyondGoodAndEvil) as { id: string };

		db.raw.exec(
			renderSqlFile(
				textLayerStatements(
					{
						documentId: document.id,
						extractor: 'unpdf@1',
						pages: hostile,
					},
					{ transcriptionId: 't1', now: '2026-09-17T00:00:00.000Z' }
				)
			)
		);

		const pages = db.raw
			.prepare(
				`SELECT page_no, text FROM pages WHERE transcription_id = 't1' ORDER BY page_no`
			)
			.all()
			.map((row) => ({ ...row }));
		expect(pages).toEqual(
			hostile.map((text, i) => ({ page_no: i + 1, text }))
		);
		db.close();
	});

	it('refuses a parameter count that does not match the placeholders', () => {
		expect(() =>
			renderStatement({ sql: 'SELECT ?, ?', params: [1] })
		).toThrow();
		expect(() =>
			renderStatement({ sql: 'SELECT ?', params: [1, 2] })
		).toThrow();
	});

	it('refuses a statement D1 would reject', () => {
		expect(() =>
			renderStatement({ sql: 'SELECT ?', params: ['x'.repeat(100_001)] })
		).toThrow(/at most/);
	});
});

describe('extracting page text', () => {
	it('returns one entry per page, empty where a page has no text', async () => {
		const pdf = await PDFDocument.create();
		const font = await pdf.embedFont(StandardFonts.TimesRoman);
		pdf.addPage().drawText('He who fights with monsters', {
			x: 50,
			y: 700,
			font,
			size: 12,
		});
		pdf.addPage();
		pdf.addPage().drawText('should be careful', {
			x: 50,
			y: 700,
			font,
			size: 12,
		});

		const pages = await extractPageTexts(await pdf.save());

		expect(pages).toHaveLength(3);
		expect(pages[0]).toContain('He who fights with monsters');
		expect(pages[1].trim()).toBe('');
		expect(pages[2]).toContain('should be careful');
	});
});

describe('the row budget', () => {
	it('stops before an item that would cross it', () => {
		const budget = new RowBudget(1000);
		expect(budget.allows(600)).toBe(true);
		budget.spend(600);
		expect(budget.allows(400)).toBe(true);
		expect(budget.allows(401)).toBe(false);
	});
});
