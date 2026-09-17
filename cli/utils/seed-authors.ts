#!/usr/bin/env tsx
/**
 * Seed Authors from Books
 *
 * Reads books.jsonl (from extract-books), extracts distinct author names,
 * and inserts them into the authors table. Then backfills books.author_id.
 *
 * Usage:
 *   npx tsx cli/utils/seed-authors.ts [options]
 *
 * Options:
 *   --env <env>      Environment: local, staging, or production (default: local)
 *   --dry-run        Print what would be inserted without executing
 *   --input <path>   Path to books.jsonl (default: local/json/books.jsonl)
 *
 * Examples:
 *   npm run seed:authors                                # Seed local from books.jsonl
 *   npm run seed:authors -- --dry-run                   # Preview without writing
 *   npm run seed:authors -- --env production             # Seed production
 */

import 'dotenv/config';
import { exec } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

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

const scriptDir = new URL('.', import.meta.url).pathname.replace(
	/^\/([A-Z]:)/,
	'$1'
);
const repoRoot = resolve(scriptDir, '..', '..');
const workerDir = resolve(repoRoot, 'apps', 'worker');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface Options {
	env: Environment;
	dryRun: boolean;
	input: string;
}

function parseArgs(): Options {
	const args = process.argv.slice(2);
	const options: Options = {
		env: 'local',
		dryRun: false,
		input: resolve(repoRoot, 'local', 'json', 'books.jsonl'),
	};

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
			case '--dry-run':
				options.dryRun = true;
				break;
			case '--input': {
				options.input = resolve(args[++i]);
				break;
			}
			case '--help':
			case '-h':
				console.log(`
Seed Authors from Books

Reads books.jsonl, extracts distinct authors, and inserts into the authors table.
Then backfills books.author_id by matching books.author = authors.name.

Usage:
  npx tsx cli/utils/seed-authors.ts [options]

Options:
  --env <env>      Environment: local, staging, or production (default: local)
  --dry-run        Print what would be inserted without executing
  --input <path>   Path to books.jsonl (default: local/json/books.jsonl)
  --help, -h       Show this help message

Examples:
  npm run seed:authors
  npm run seed:authors -- --dry-run
  npm run seed:authors -- --env production
`);
				process.exit(0);
		}
	}

	return options;
}

async function executeSQL(
	database: string,
	flags: string,
	sql: string
): Promise<void> {
	const normalizedSQL = sql.replace(/\s+/g, ' ').trim();
	const escapedSQL = normalizedSQL.replace(/"/g, '\\"');
	const command = `npx wrangler d1 execute ${database} ${flags} --command="${escapedSQL}"`;

	await execAsync(command, {
		cwd: workerDir,
		maxBuffer: 50 * 1024 * 1024,
	});
}

interface BookRecord {
	id: string;
	title: string;
	author: string;
	[key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const { env, dryRun, input } = parseArgs();
	const config = ENV_CONFIG[env];

	console.log(`Reading books from ${input}...`);

	let raw: string;
	try {
		raw = readFileSync(input, 'utf-8');
	} catch {
		console.error(`Could not read ${input}`);
		console.error('Run extract:books first: npm run extract:books');
		process.exit(1);
	}

	const books: BookRecord[] = raw
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));

	// Extract distinct author names
	const authorNames = [...new Set(books.map((b) => b.author))].sort();

	console.log(
		`\nFound ${books.length} books by ${authorNames.length} distinct authors:\n`
	);

	const authorRecords = authorNames.map((name) => ({
		id: randomUUID(),
		name,
		bookCount: books.filter((b) => b.author === name).length,
	}));

	for (const a of authorRecords) {
		console.log(
			`  ${a.name} (${a.bookCount} book${a.bookCount > 1 ? 's' : ''})`
		);
	}

	if (dryRun) {
		console.log('\n[DRY RUN] No changes written.');
		console.log('\nSQL that would be executed:\n');
		for (const a of authorRecords) {
			const now = new Date().toISOString();
			const escapedName = a.name.replace(/'/g, "''");
			console.log(
				`INSERT INTO authors (id, name, created_at, updated_at) VALUES ('${a.id}', '${escapedName}', '${now}', '${now}');`
			);
		}
		console.log('\nBackfill:');
		console.log(
			`UPDATE books SET author_id = (SELECT id FROM authors WHERE authors.name = books.author) WHERE author_id IS NULL;`
		);
		return;
	}

	// Confirm for production
	if (env === 'production') {
		const readline = await import('node:readline');
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		const answer = await new Promise<string>((resolve) => {
			rl.question(
				`\n⚠️  About to write to PRODUCTION. Continue? (yes/no): `,
				resolve
			);
		});
		rl.close();
		if (answer.toLowerCase() !== 'yes') {
			console.log('Aborted.');
			process.exit(0);
		}
	}

	console.log(`\nSeeding authors into ${env} (${config.database})...`);

	// Insert authors one by one (D1 doesn't support multi-row INSERT well via CLI)
	const now = new Date().toISOString();
	let inserted = 0;
	for (const a of authorRecords) {
		const escapedName = a.name.replace(/'/g, "''");
		try {
			await executeSQL(
				config.database,
				config.flags,
				`INSERT OR IGNORE INTO authors (id, name, created_at, updated_at) VALUES ('${a.id}', '${escapedName}', '${now}', '${now}')`
			);
			inserted++;
			console.log(`  ✓ ${a.name}`);
		} catch (err) {
			console.error(`  ✗ ${a.name}: ${err}`);
		}
	}

	console.log(`\nInserted ${inserted}/${authorRecords.length} authors.`);

	// Backfill books.author_id
	console.log(`\nBackfilling books.author_id...`);
	try {
		await executeSQL(
			config.database,
			config.flags,
			`UPDATE books SET author_id = (SELECT id FROM authors WHERE authors.name = books.author) WHERE author_id IS NULL`
		);
		console.log(`  ✓ Backfill complete.`);
	} catch (err) {
		console.error(`  ✗ Backfill failed: ${err}`);
	}

	console.log('\nDone.');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
