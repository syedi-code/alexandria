#!/usr/bin/env tsx
/**
 * Extract Essays from D1
 *
 * Exports essays (with their book references) from a D1 database to a local file.
 * Default format is JSONL (one JSON object per line) for token efficiency.
 *
 * Usage:
 *   npx tsx cli/utils/extract-essays.ts [options]
 *
 * Options:
 *   --env <env>    Environment: local, staging, or production (default: production)
 *   --json         Output as pretty-printed JSON array instead of JSONL
 *
 * Examples:
 *   npm run extract:essays                          # JSONL from production
 *   npm run extract:essays -- --json                # Pretty JSON from production
 *   npm run extract:essays -- --env local           # JSONL from local
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
Extract Essays from D1

Usage:
  npx tsx cli/utils/extract-essays.ts [options]

Options:
  --env <env>    Environment: local, staging, or production (default: production)
  --json         Output as pretty-printed JSON array instead of JSONL
  --help, -h     Show this help message

Examples:
  npm run extract:essays
  npm run extract:essays -- --json
  npm run extract:essays -- --env local
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

interface EssayRow {
	id: string;
	content: string;
	posted: number;
	tags: string | null;
	replaces: string | null;
	source: string;
	created_at: string;
	updated_at: string;
}

interface EssayReferenceRow {
	id: string;
	essay_id: string;
	entity_type: string;
	entity_id: string;
	page: string | null;
	position: number;
}

async function main(): Promise<void> {
	const { env, json } = parseArgs();
	const config = ENV_CONFIG[env];
	const userId = process.env.USER_ID;
	if (!userId) {
		console.error('USER_ID environment variable is required');
		process.exit(1);
	}

	console.log(`Extracting essays from ${env} (${config.database})...`);

	const essays = await executeQuery<EssayRow>(
		config.database,
		config.flags,
		`
		SELECT id, content, posted, tags, replaces, source, created_at, updated_at
		FROM essays
		WHERE user_id = '${userId}'
		  AND id NOT IN (SELECT replaces FROM essays WHERE replaces IS NOT NULL)
		ORDER BY created_at DESC
		`
	);

	const references = await executeQuery<EssayReferenceRow>(
		config.database,
		config.flags,
		`
		SELECT er.id, er.essay_id, er.entity_type, er.entity_id, er.page, er.position
		FROM essay_references er
		INNER JOIN essays e ON e.id = er.essay_id
		WHERE e.user_id = '${userId}'
		ORDER BY er.essay_id, er.position
		`
	);

	const refsByEssay = new Map<string, EssayReferenceRow[]>();
	for (const ref of references) {
		const list = refsByEssay.get(ref.essay_id) ?? [];
		list.push(ref);
		refsByEssay.set(ref.essay_id, list);
	}

	const extracted = essays.map((e) => ({
		...e,
		references: refsByEssay.get(e.id) ?? [],
	}));

	const outDir = resolve(repoRoot, 'local', 'json');
	if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

	const ext = json ? 'json' : 'jsonl';
	const outFile = resolve(outDir, `essays.${ext}`);
	const content = json
		? JSON.stringify(extracted, null, 2)
		: extracted.map((r) => JSON.stringify(r)).join('\n');

	writeFileSync(outFile, content);
	console.log(
		`Extracted ${essays.length} essays (${references.length} references) to ${outFile}`
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
