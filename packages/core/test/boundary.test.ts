import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { readFileSync, globSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const eslint = new ESLint({ cwd: repoRoot });

async function lint(filePath: string, source: string) {
	const [result] = await eslint.lintText(source, {
		filePath: path.join(repoRoot, filePath),
	});
	return result.messages.filter((m) => m.ruleId === 'no-restricted-imports');
}

describe('the works/writing boundary rule', () => {
	it('rejects a relative import from works/ into writing/', async () => {
		const messages = await lint(
			'packages/core/works/violation.ts',
			"import { getLibraryBooks } from '../writing/enrichment.js';\nexport const x = getLibraryBooks;\n"
		);
		expect(messages).toHaveLength(1);
		expect(messages[0].message).toContain('may not import writing/');
	});

	it('rejects the package root from works/, because it re-exports both domains', async () => {
		const messages = await lint(
			'packages/core/works/violation.ts',
			"import type { Env } from '@alexandria/core';\nexport type E = Env;\n"
		);
		expect(messages).toHaveLength(1);
	});

	it('rejects a worker works route reaching into writing/', async () => {
		const messages = await lint(
			'apps/worker/api/works/violation.ts',
			"import { getBookDetail } from '@alexandria/core/writing';\nexport const x = getBookDetail;\n"
		);
		expect(messages).toHaveLength(1);
	});

	it('allows works/ to import platform/ and its own module', async () => {
		const messages = await lint(
			'packages/core/works/allowed.ts',
			"import { MAX_LENGTHS } from '../platform/limits.js';\nimport { getBookById } from './books.js';\nexport const x = [MAX_LENGTHS, getBookById];\n"
		);
		expect(messages).toEqual([]);
	});

	it('allows writing/ to import works/ — that is the permitted direction', async () => {
		const messages = await lint(
			'packages/core/writing/allowed.ts',
			"import { listCatalogue } from '../works/catalogue.js';\nexport const x = listCatalogue;\n"
		);
		expect(messages).toEqual([]);
	});

	it('rejects platform/ importing either domain', async () => {
		for (const source of [
			"import { getBookById } from '../works/books.js';\nexport const x = getBookById;\n",
			"import { getBookDetail } from '../writing/enrichment.js';\nexport const x = getBookDetail;\n",
		]) {
			expect(
				await lint('packages/core/platform/violation.ts', source)
			).toHaveLength(1);
		}
	});
});

describe('the conversations boundary', () => {
	it('rejects works/ importing conversations/', async () => {
		const messages = await lint(
			'packages/core/works/violation.ts',
			"import { PageHandles } from '../conversations/handles.js';\nexport const x = PageHandles;\n"
		);
		expect(messages).toHaveLength(1);
	});

	it('rejects the MCP server reaching past works/', async () => {
		for (const source of [
			"import { listMessages } from '@alexandria/core/conversations';\nexport const x = listMessages;\n",
			"import { getBookDetail } from '@alexandria/core/writing';\nexport const x = getBookDetail;\n",
		]) {
			expect(
				await lint('apps/worker/api/mcp/violation.ts', source)
			).toHaveLength(1);
		}
	});

	it('keeps writing/ and conversations/ out of each other', async () => {
		expect(
			await lint(
				'packages/core/conversations/violation.ts',
				"import { getBookDetail } from '../writing/enrichment.js';\nexport const x = getBookDetail;\n"
			)
		).toHaveLength(1);
		expect(
			await lint(
				'packages/core/writing/violation.ts',
				"import { PageHandles } from '../conversations/handles.js';\nexport const x = PageHandles;\n"
			)
		).toHaveLength(1);
	});

	it('allows conversations/ to import works/ and platform/', async () => {
		const messages = await lint(
			'packages/core/conversations/allowed.ts',
			"import { verifyCitations } from '../works/citations.js';\nimport { insertRows } from '../platform/sql.js';\nexport const x = [verifyCitations, insertRows];\n"
		);
		expect(messages).toEqual([]);
	});
});

describe('the seam as it actually stands', () => {
	const worksFiles = globSync('packages/core/works/*.ts', {
		cwd: repoRoot,
	}).filter((f) => !f.endsWith('.d.ts'));

	// Prose mentions writing tables constantly; SQL is what must not.
	const stripComments = (source: string) =>
		source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

	it('finds the works module', () => {
		expect(worksFiles.length).toBeGreaterThan(0);
	});

	it.each(worksFiles)('%s names no writing table in its SQL', (file) => {
		const source = stripComments(
			readFileSync(path.join(repoRoot, file), 'utf8')
		);
		for (const table of [
			'quotes',
			'notes',
			'essays',
			'essay_references',
			'essay_images',
			'threads',
			'thread_items',
			'connections',
			'thoughts',
			'sleep',
		]) {
			expect(source).not.toMatch(
				new RegExp(`(FROM|JOIN|INTO|UPDATE)\\s+${table}\\b`, 'i')
			);
		}
	});
});
