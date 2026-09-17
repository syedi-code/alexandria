#!/usr/bin/env tsx
/**
 * Extract Threads from D1
 *
 * Exports threads (with their items) from a D1 database to a local file.
 * Default format is JSONL (one JSON object per line) for token efficiency.
 *
 * Usage:
 *   npx tsx cli/utils/extract-threads.ts [options]
 *
 * Options:
 *   --env <env>    Environment: local, staging, or production (default: production)
 *   --json         Output as pretty-printed JSON array instead of JSONL
 *
 * Examples:
 *   npm run extract:threads                          # JSONL from production
 *   npm run extract:threads -- --json                # Pretty JSON from production
 *   npm run extract:threads -- --env local           # JSONL from local
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
Extract Threads from D1

Usage:
  npx tsx cli/utils/extract-threads.ts [options]

Options:
  --env <env>    Environment: local, staging, or production (default: production)
  --json         Output as pretty-printed JSON array instead of JSONL
  --help, -h     Show this help message

Examples:
  npm run extract:threads
  npm run extract:threads -- --json
  npm run extract:threads -- --env local
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

interface ThreadRow {
	id: string;
	name: string;
	description: string | null;
	created_at: string;
	updated_at: string;
}

interface ThreadItemRow {
	id: string;
	thread_id: string;
	entity_type: string;
	entity_id: string;
	position: number;
	added_at: string;
}

async function main(): Promise<void> {
	const { env, json } = parseArgs();
	const config = ENV_CONFIG[env];
	const userId = process.env.USER_ID;
	if (!userId) {
		console.error('USER_ID environment variable is required');
		process.exit(1);
	}

	console.log(`Extracting threads from ${env} (${config.database})...`);

	const threads = await executeQuery<ThreadRow>(
		config.database,
		config.flags,
		`
		SELECT id, name, description, created_at, updated_at
		FROM threads
		WHERE user_id = '${userId}'
		ORDER BY created_at DESC
		`
	);

	const items = await executeQuery<ThreadItemRow>(
		config.database,
		config.flags,
		`
		SELECT ti.id, ti.thread_id, ti.entity_type, ti.entity_id, ti.position, ti.added_at
		FROM thread_items ti
		INNER JOIN threads t ON t.id = ti.thread_id
		WHERE t.user_id = '${userId}'
		ORDER BY ti.thread_id, ti.position
		`
	);

	const itemsByThread = new Map<string, ThreadItemRow[]>();
	for (const item of items) {
		const list = itemsByThread.get(item.thread_id) ?? [];
		list.push(item);
		itemsByThread.set(item.thread_id, list);
	}

	const extracted = threads.map((t) => ({
		...t,
		items: itemsByThread.get(t.id) ?? [],
	}));

	const outDir = resolve(repoRoot, 'local', 'json');
	if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

	const ext = json ? 'json' : 'jsonl';
	const outFile = resolve(outDir, `threads.${ext}`);
	const content = json
		? JSON.stringify(extracted, null, 2)
		: extracted.map((r) => JSON.stringify(r)).join('\n');

	writeFileSync(outFile, content);
	console.log(
		`Extracted ${threads.length} threads (${items.length} items) to ${outFile}`
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
