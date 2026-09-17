#!/usr/bin/env tsx
/**
 * Extract Thoughts from D1
 *
 * Exports thoughts from a D1 database to a local file.
 * Default format is JSONL (one JSON object per line) for token efficiency.
 *
 * Usage:
 *   npx tsx cli/utils/extract-thoughts.ts [options]
 *
 * Options:
 *   --env <env>    Environment: local, staging, or production (default: production)
 *   --compact      Output only content and created_at
 *   --json         Output as pretty-printed JSON array instead of JSONL
 *
 * Examples:
 *   npm run extract:thoughts                          # JSONL from production
 *   npm run extract:thoughts -- --json                # Pretty JSON from production
 *   npm run extract:thoughts -- --compact             # Minimal JSONL output
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
Extract Thoughts from D1

Usage:
  npx tsx cli/utils/extract-thoughts.ts [options]

Options:
  --env <env>    Environment: local, staging, or production (default: production)
  --compact      Output only content and created_at
  --json         Output as pretty-printed JSON array instead of JSONL
  --help, -h     Show this help message

Examples:
  npm run extract:thoughts
  npm run extract:thoughts -- --json
  npm run extract:thoughts -- --compact
`);
				process.exit(0);
		}
	}

	return options;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

interface ThoughtRow {
	id: string;
	content: string;
	author: string;
	created_at: string;
	mood_score: number | null;
	mood_tags: string | null;
}

async function main(): Promise<void> {
	const { env, compact, json } = parseArgs();
	const userId = process.env.USER_ID;
	if (!userId) {
		console.error('USER_ID environment variable is required');
		process.exit(1);
	}

	console.log(`Extracting thoughts from ${env}...`);

	const results = await query<ThoughtRow>(env, 'db', {
		sql: `
		SELECT id, content, author, created_at, mood_score, mood_tags
		FROM thoughts
		WHERE user_id = ?
		ORDER BY created_at DESC
		`,
		params: [userId],
	});

	const extracted = results.map((r) => {
		if (compact) {
			return { content: r.content, created_at: r.created_at };
		}
		return {
			id: r.id,
			content: r.content,
			author: r.author,
			created_at: r.created_at,
			mood_score: r.mood_score,
			mood_tags: r.mood_tags ? JSON.parse(r.mood_tags) : null,
		};
	});

	const outDir = resolve(repoRoot, 'local', 'json');
	if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

	const ext = json ? 'json' : 'jsonl';
	const outFile = resolve(outDir, `thoughts.${ext}`);
	const content = json
		? JSON.stringify(extracted, null, 2)
		: extracted.map((r) => JSON.stringify(r)).join('\n');

	writeFileSync(outFile, content);
	console.log(`Extracted ${extracted.length} thoughts to ${outFile}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
