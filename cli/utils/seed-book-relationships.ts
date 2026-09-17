#!/usr/bin/env tsx
/**
 * Seed Book Relationships
 *
 * Links existing books to authors by matching books.author (text) to authors.name,
 * then setting books.author_id. Safe to re-run — skips books that already have an author_id.
 *
 * Usage:
 *   npx tsx cli/utils/seed-book-relationships.ts [options]
 *
 * Options:
 *   --env <env>      Environment: local, staging, or production (default: local)
 *   --dry-run        Print what would be updated without executing
 *
 * Examples:
 *   npm run seed:book-relationships                          # Link local
 *   npm run seed:book-relationships -- --dry-run             # Preview without writing
 *   npm run seed:book-relationships -- --env production      # Link production
 */

import 'dotenv/config';
import { exec } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

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
}

function parseArgs(): Options {
	const args = process.argv.slice(2);
	const options: Options = { env: 'local', dryRun: false };

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
			case '--help':
			case '-h':
				console.log(`
Seed Book Relationships

Matches books.author (text) to authors.name and sets books.author_id.
Safe to re-run — skips books that already have an author_id.

Usage:
  npx tsx cli/utils/seed-book-relationships.ts [options]

Options:
  --env <env>      Environment: local, staging, or production (default: local)
  --dry-run        Print what would be updated without executing
  --help, -h       Show this help message

Examples:
  npm run seed:book-relationships
  npm run seed:book-relationships -- --dry-run
  npm run seed:book-relationships -- --env production
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

interface BookRow {
	id: string;
	title: string;
	author: string;
	author_id: string | null;
}

interface AuthorRow {
	id: string;
	name: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const { env, dryRun } = parseArgs();
	const config = ENV_CONFIG[env];

	console.log(
		`Querying books and authors from ${env} (${config.database})...`
	);

	const [books, authors] = await Promise.all([
		executeQuery<BookRow>(
			config.database,
			config.flags,
			`SELECT id, title, author, author_id FROM books`
		),
		executeQuery<AuthorRow>(
			config.database,
			config.flags,
			`SELECT id, name FROM authors`
		),
	]);

	console.log(`Found ${books.length} books and ${authors.length} authors.\n`);

	// Build case-insensitive name → author lookup
	const authorByName = new Map<string, AuthorRow>();
	for (const a of authors) {
		authorByName.set(a.name.toLowerCase(), a);
	}

	// Classify books
	const alreadyLinked: BookRow[] = [];
	const toUpdate: { book: BookRow; author: AuthorRow }[] = [];
	const unmatched: BookRow[] = [];

	for (const book of books) {
		if (book.author_id) {
			alreadyLinked.push(book);
			continue;
		}

		const match = authorByName.get(book.author.toLowerCase());
		if (match) {
			toUpdate.push({ book, author: match });
		} else {
			unmatched.push(book);
		}
	}

	// Print summary
	console.log(`Already linked: ${alreadyLinked.length}`);
	console.log(`To link:        ${toUpdate.length}`);
	console.log(`Unmatched:      ${unmatched.length}`);

	if (toUpdate.length > 0) {
		console.log(`\nWill link:`);
		for (const { book, author } of toUpdate) {
			console.log(
				`  "${book.title}" → ${author.name} (${author.id.slice(0, 8)}...)`
			);
		}
	}

	if (unmatched.length > 0) {
		console.log(`\nUnmatched books (no author found):`);
		for (const book of unmatched) {
			console.log(`  "${book.title}" by "${book.author}"`);
		}
	}

	if (toUpdate.length === 0) {
		console.log('\nNothing to update.');
		return;
	}

	if (dryRun) {
		console.log('\n[DRY RUN] No changes written.');
		console.log('\nSQL that would be executed:\n');
		for (const { book, author } of toUpdate) {
			console.log(
				`UPDATE books SET author_id = '${author.id}' WHERE id = '${book.id}';`
			);
		}
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
				`\nAbout to update ${toUpdate.length} books in PRODUCTION. Continue? (yes/no): `,
				resolve
			);
		});
		rl.close();
		if (answer.toLowerCase() !== 'yes') {
			console.log('Aborted.');
			process.exit(0);
		}
	}

	console.log(`\nLinking books to authors in ${env}...`);

	let updated = 0;
	for (const { book, author } of toUpdate) {
		try {
			await executeSQL(
				config.database,
				config.flags,
				`UPDATE books SET author_id = '${author.id}' WHERE id = '${book.id}'`
			);
			updated++;
			console.log(`  ✓ "${book.title}" → ${author.name}`);
		} catch (err) {
			console.error(`  ✗ "${book.title}": ${err}`);
		}
	}

	console.log(`\nLinked ${updated}/${toUpdate.length} books.`);
	console.log('Done.');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
