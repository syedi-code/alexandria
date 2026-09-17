#!/usr/bin/env tsx
/**
 * Extract Books from D1
 *
 * Exports books from a D1 database to a local file.
 * Default format is JSONL (one JSON object per line) for token efficiency.
 *
 * Usage:
 *   npx tsx cli/utils/extract-books.ts [options]
 *
 * Options:
 *   --env <env>    Environment: local, staging, or production (default: production)
 *   --compact      Output only title and author
 *   --json         Output as pretty-printed JSON array instead of JSONL
 *
 * Examples:
 *   npm run extract:books                          # JSONL from production
 *   npm run extract:books -- --json                # Pretty JSON from production
 *   npm run extract:books -- --compact             # Minimal JSONL output
 */

import dotenv from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEnvironment, query, type Environment } from '../wrangler.js';
import { BOOK_COLUMNS, BOOK_FROM, BOOK_WHERE } from '@alexandria/core/works';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const scriptDir = new URL('.', import.meta.url).pathname.replace(
	/^\/([A-Z]:)/,
	'$1'
);
const repoRoot = resolve(scriptDir, '..', '..');

dotenv.config({ path: resolve(repoRoot, '.env') });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface Options {
	env: Environment;
	compact: boolean;
	json: boolean;
}

function parseArgs(): Options {
	const args = process.argv.slice(2);
	const options: Options = { env: 'production', compact: false, json: false };

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--env': {
				const env = args[++i];
				if (!isEnvironment(env)) {
					console.error(`Invalid environment: ${env}`);
					console.error('Valid options: local, staging, production');
					process.exit(1);
				}
				options.env = env;
				break;
			}
			case '--compact':
				options.compact = true;
				break;
			case '--json':
				options.json = true;
				break;
			case '--help':
			case '-h':
				console.log(`
Extract Books from D1

Usage:
  npx tsx cli/utils/extract-books.ts [options]

Options:
  --env <env>    Environment: local, staging, or production (default: production)
  --compact      Output only title and author
  --json         Output as pretty-printed JSON array instead of JSONL
  --help, -h     Show this help message

Examples:
  npm run extract:books
  npm run extract:books -- --json
  npm run extract:books -- --compact
`);
				process.exit(0);
		}
	}

	return options;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

interface BookRow {
	id: string;
	title: string;
	author: string;
	pdf_url: string | null;
	cover_url: string | null;
	isbn: string | null;
	description: string | null;
	originally_published: string | null;
	pdf_page_offset: number;
	created_at: string;
	updated_at: string;
}

async function main(): Promise<void> {
	const { env, compact, json } = parseArgs();

	console.log(`Extracting books from ${env}...`);

	const results = await query<BookRow>(env, 'db', {
		sql: `SELECT ${BOOK_COLUMNS} ${BOOK_FROM}
		  WHERE ${BOOK_WHERE}
		  ORDER BY w.created_at DESC`,
	});

	const extracted = results.map((r) => {
		if (compact) {
			return { title: r.title, author: r.author };
		}
		return {
			id: r.id,
			title: r.title,
			author: r.author,
			isbn: r.isbn,
			description: r.description,
			originally_published: r.originally_published,
			pdf_url: r.pdf_url,
			pdf_page_offset: r.pdf_page_offset,
			created_at: r.created_at,
			updated_at: r.updated_at,
		};
	});

	const outDir = resolve(repoRoot, 'local', 'json');
	if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

	const ext = json ? 'json' : 'jsonl';
	const outFile = resolve(outDir, `books.${ext}`);
	const content = json
		? JSON.stringify(extracted, null, 2)
		: extracted.map((r) => JSON.stringify(r)).join('\n');

	writeFileSync(outFile, content);
	console.log(`Extracted ${extracted.length} books to ${outFile}`);

	// Print distinct authors summary
	const authors = [...new Set(results.map((r) => r.author))].sort();
	console.log(`\nDistinct authors (${authors.length}):`);
	for (const a of authors) {
		const count = results.filter((r) => r.author === a).length;
		console.log(`  ${a} (${count} book${count > 1 ? 's' : ''})`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
