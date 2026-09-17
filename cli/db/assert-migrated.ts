#!/usr/bin/env tsx
/**
 * Refuse to proceed unless the target database has the tables the code
 * expects.
 *
 * The worker reads `works`; a database that has not had 0026_works.sql applied
 * still has `books`. Deploying into that gap takes production down until the
 * migration runs, and CI deploys on push to main — so this runs first and
 * fails loudly rather than letting the deploy land.
 *
 * Usage:
 *   npx tsx cli/db/assert-migrated.ts --env <local|staging|production>
 */

import 'dotenv/config';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

// wrangler resolves database names and --env from the worker's wrangler.toml.
const WORKER_DIR = path.resolve(import.meta.dirname, '../../apps/worker');

const execAsync = promisify(exec);

const ENV_CONFIG = {
	local: { database: 'antisocial-media', flags: '--local' },
	staging: {
		database: 'antisocial-media-staging',
		flags: '--env staging --remote',
	},
	production: { database: 'antisocial-media', flags: '--remote' },
} as const;

type Environment = keyof typeof ENV_CONFIG;

/**
 * Tables the current code reads. Add one here in the same commit that starts
 * reading it, and the guard starts covering it.
 */
const REQUIRED_TABLES = [
	'works',
	'creators',
	'work_media',
	'documents',
	'transcriptions',
	'pages',
	'notes',
	'quotes',
	'essays',
	'essay_references',
	'essay_images',
	'thoughts',
	'threads',
	'thread_items',
	'connections',
	'links',
	'media',
	'sleep',
	'users',
	'sessions',
	'access_audit_log',
];

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const envIndex = args.indexOf('--env');
	const env = (envIndex >= 0 ? args[envIndex + 1] : '') as Environment;

	if (!ENV_CONFIG[env]) {
		console.error(
			'Usage: npx tsx cli/db/assert-migrated.ts --env <local|staging|production>'
		);
		process.exit(2);
	}

	const { database, flags } = ENV_CONFIG[env];
	const { stdout } = await execAsync(
		`npx wrangler d1 execute ${database} ${flags} --json ` +
			`--command="SELECT name FROM sqlite_master WHERE type='table'"`,
		{ maxBuffer: 8 * 1024 * 1024, cwd: WORKER_DIR }
	);

	const parsed = JSON.parse(stdout) as { results: { name: string }[] }[];
	const present = new Set(
		parsed.flatMap((r) => r.results ?? []).map((r) => r.name)
	);
	const missing = REQUIRED_TABLES.filter((t) => !present.has(t));

	if (missing.length === 0) {
		console.log(`${env}: schema is up to date (${present.size} tables).`);
		return;
	}

	console.error(
		`${env}: missing ${missing.length} table(s): ${missing.join(', ')}`
	);
	if (present.has('books') && missing.includes('works')) {
		console.error(
			'\nThis database still has `books`. Apply sql/migrations/0026_works.sql\n' +
				'before deploying — see docs/WORKS-MIGRATION.md. Deploying first takes\n' +
				'production down until the migration runs.'
		);
	}
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
