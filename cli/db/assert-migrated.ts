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
import { isEnvironment, query } from '../wrangler.js';

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
	'usage_events',
];

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const envIndex = args.indexOf('--env');
	const env = envIndex >= 0 ? args[envIndex + 1] : '';

	if (!isEnvironment(env)) {
		console.error(
			'Usage: npx tsx cli/db/assert-migrated.ts --env <local|staging|production>'
		);
		process.exit(2);
	}

	const tables = await query<{ name: string }>(env, 'db', {
		sql: `SELECT name FROM sqlite_master WHERE type = 'table'`,
	});
	const present = new Set(tables.map((table) => table.name));
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
