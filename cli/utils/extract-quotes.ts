#!/usr/bin/env tsx
/**
 * Extract Quotes from D1
 *
 * Exports quotes from a D1 database to a local file.
 * Default format is JSONL (one JSON object per line) for token efficiency.
 *
 * Usage:
 *   npx tsx cli/utils/extract-quotes.ts [options]
 *
 * Options:
 *   --env <env>    Environment: local, staging, or production (default: production)
 *   --json         Output as pretty-printed JSON array instead of JSONL
 *
 * Examples:
 *   npm run extract:quotes                          # JSONL from production
 *   npm run extract:quotes -- --json                # Pretty JSON from production
 *   npm run extract:quotes -- --env local           # JSONL from local
 */

import dotenv from 'dotenv';
import { exec } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const scriptDir = new URL('.', import.meta.url).pathname.replace(
	/^\/([A-Z]:)/,
	'$1'
);
const repoRoot = resolve(scriptDir, '..', '..');
const workerDir = resolve(repoRoot, 'apps', 'worker');

dotenv.config({ path: resolve(repoRoot, '.env') });

const ENV_CONFIG = {
	local: {
		database: 'antisocial-media',
		flags: '--local',
	},
	staging: {
		database: 'antisocial-media-staging',
		flags: '--remote',
	},
	production: {
		database: 'antisocial-media',
		flags: '--remote',
	},
} as const;

type Environment = keyof typeof ENV_CONFIG;

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
				const env = args[++i] as Environment;
				if (!['local', 'staging', 'production'].includes(env)) {
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
Extract Quotes from D1

Usage:
  npx tsx cli/utils/extract-quotes.ts [options]

Options:
  --env <env>    Environment: local, staging, or production (default: production)
  --json         Output as pretty-printed JSON array instead of JSONL
  --help, -h     Show this help message

Examples:
  npm run extract:quotes
  npm run extract:quotes -- --json
  npm run extract:quotes -- --env local
`);
				process.exit(0);
		}
	}

	return options;
}

interface D1QueryResult<T> {
	success: boolean;
	results: T[];
}

async function executeQuery<T>(
	database: string,
	flags: string,
	query: string
): Promise<T[]> {
	const normalizedQuery = query.replace(/\s+/g, ' ').trim();
	const escapedQuery = normalizedQuery.replace(/"/g, '\\"');
	const command = `npx wrangler d1 execute ${database} ${flags} --json --command="${escapedQuery}"`;

	const { stdout } = await execAsync(command, {
		cwd: workerDir,
		maxBuffer: 50 * 1024 * 1024,
	});

	const parsed: D1QueryResult<T>[] = JSON.parse(stdout);
	return parsed[0]?.results || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

interface QuoteRow {
	id: string;
	quote: string;
	work: string | null;
	creator: string | null;
	kind: string | null;
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
	const config = ENV_CONFIG[env];
	const userId = process.env.USER_ID;
	if (!userId) {
		console.error('USER_ID environment variable is required');
		process.exit(1);
	}

	console.log(`Extracting quotes from ${env} (${config.database})...`);

	const results = await executeQuery<QuoteRow>(
		config.database,
		config.flags,
		`
		SELECT q.id, q.quote, q.work, q.creator, q.kind, q.book_id, q.page, q.posted, q.tags, q.replaces, q.source, q.created_at, q.updated_at
		FROM quotes q
		WHERE q.user_id = '${userId}'
		  AND q.id NOT IN (SELECT replaces FROM quotes WHERE replaces IS NOT NULL)
		ORDER BY q.created_at DESC
		`
	);

	const outDir = resolve(repoRoot, 'local', 'json');
	if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

	const ext = json ? 'json' : 'jsonl';
	const outFile = resolve(outDir, `quotes.${ext}`);
	const content = json
		? JSON.stringify(results, null, 2)
		: results.map((r) => JSON.stringify(r)).join('\n');

	writeFileSync(outFile, content);
	console.log(`Extracted ${results.length} quotes to ${outFile}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
