#!/usr/bin/env tsx
/**
 * Extract Notes from D1
 *
 * Exports notes from a D1 database to a local file.
 * Default format is JSONL (one JSON object per line) for token efficiency.
 *
 * Usage:
 *   npx tsx cli/utils/extract-notes.ts [options]
 *
 * Options:
 *   --env <env>    Environment: local, staging, or production (default: production)
 *   --json         Output as pretty-printed JSON array instead of JSONL
 *
 * Examples:
 *   npm run extract:notes                          # JSONL from production
 *   npm run extract:notes -- --json                # Pretty JSON from production
 *   npm run extract:notes -- --env local           # JSONL from local
 */

import dotenv from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEnvironment, query, type Environment } from '../wrangler.js';

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
	json: boolean;
}

function parseArgs(): Options {
	const args = process.argv.slice(2);
	const options: Options = { env: 'production', json: false };

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
			case '--json':
				options.json = true;
				break;
			case '--help':
			case '-h':
				console.log(`
Extract Notes from D1

Usage:
  npx tsx cli/utils/extract-notes.ts [options]

Options:
  --env <env>    Environment: local, staging, or production (default: production)
  --json         Output as pretty-printed JSON array instead of JSONL
  --help, -h     Show this help message

Examples:
  npm run extract:notes
  npm run extract:notes -- --json
  npm run extract:notes -- --env local
`);
				process.exit(0);
		}
	}

	return options;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

interface NoteRow {
	id: string;
	content: string;
	book_id: string | null;
	page: string | null;
	posted: number;
	tags: string | null;
	replaces: string | null;
	source: string;
	created_at: string;
	updated_at: string;
}

async function main(): Promise<void> {
	const { env, json } = parseArgs();
	const userId = process.env.USER_ID;
	if (!userId) {
		console.error('USER_ID environment variable is required');
		process.exit(1);
	}

	console.log(`Extracting notes from ${env}...`);

	const results = await query<NoteRow>(env, 'db', {
		sql: `
		SELECT n.id, n.content, n.book_id, n.page, n.posted, n.tags, n.replaces, n.source, n.created_at, n.updated_at
		FROM notes n
		WHERE n.user_id = ?
		  AND n.id NOT IN (SELECT replaces FROM notes WHERE replaces IS NOT NULL)
		ORDER BY n.created_at DESC
		`,
		params: [userId],
	});

	const outDir = resolve(repoRoot, 'local', 'json');
	if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

	const ext = json ? 'json' : 'jsonl';
	const outFile = resolve(outDir, `notes.${ext}`);
	const content = json
		? JSON.stringify(results, null, 2)
		: results.map((r) => JSON.stringify(r)).join('\n');

	writeFileSync(outFile, content);
	console.log(`Extracted ${results.length} notes to ${outFile}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
