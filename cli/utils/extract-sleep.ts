#!/usr/bin/env tsx
/**
 * Extract Sleep from D1
 *
 * Exports sleep entries from a D1 database to a local file.
 * Default format is JSONL (one JSON object per line) for token efficiency.
 *
 * Usage:
 *   npx tsx cli/utils/extract-sleep.ts [options]
 *
 * Options:
 *   --env <env>    Environment: local, staging, or production (default: production)
 *   --json         Output as pretty-printed JSON array instead of JSONL
 *
 * Examples:
 *   npm run extract:sleep                          # JSONL from production
 *   npm run extract:sleep -- --json                # Pretty JSON from production
 *   npm run extract:sleep -- --env local           # JSONL from local
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
Extract Sleep from D1

Usage:
  npx tsx cli/utils/extract-sleep.ts [options]

Options:
  --env <env>    Environment: local, staging, or production (default: production)
  --json         Output as pretty-printed JSON array instead of JSONL
  --help, -h     Show this help message

Examples:
  npm run extract:sleep
  npm run extract:sleep -- --json
  npm run extract:sleep -- --env local
`);
				process.exit(0);
		}
	}

	return options;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

interface SleepRow {
	id: string;
	hours: number;
	quality: number | null;
	bed_time: string | null;
	wake_time: string | null;
	note: string | null;
	tags: string | null;
	source: string;
	created_at: string;
}

async function main(): Promise<void> {
	const { env, json } = parseArgs();
	const userId = process.env.USER_ID;
	if (!userId) {
		console.error('USER_ID environment variable is required');
		process.exit(1);
	}

	console.log(`Extracting sleep from ${env}...`);

	const results = await query<SleepRow>(env, 'db', {
		sql: `
		SELECT id, hours, quality, bed_time, wake_time, note, tags, source, created_at
		FROM sleep
		WHERE user_id = ?
		ORDER BY created_at DESC
		`,
		params: [userId],
	});

	const outDir = resolve(repoRoot, 'local', 'json');
	if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

	const ext = json ? 'json' : 'jsonl';
	const outFile = resolve(outDir, `sleep.${ext}`);
	const content = json
		? JSON.stringify(results, null, 2)
		: results.map((r) => JSON.stringify(r)).join('\n');

	writeFileSync(outFile, content);
	console.log(`Extracted ${results.length} sleep entries to ${outFile}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
