#!/usr/bin/env tsx
/**
 * Migrate Event Ledger → Denormalized Tables
 *
 * Reads events of type note, quote, media, link, sleep from event_ledger
 * and inserts them into the new columnar tables. Preserves IDs, timestamps,
 * replaces chains, book_id references, and posted flags.
 *
 * Usage:
 *   npx tsx cli/db/migrate-events.ts --env <env> [options]
 *
 * Options:
 *   --env <env>    Environment: local, staging, or production (required)
 *   --dry-run      Print SQL without executing
 *   --yes, -y      Skip confirmation prompt
 *   --type <type>  Migrate only one type (note, quote, media, link, sleep)
 *
 * Examples:
 *   npm run migrate:events -- --env local
 *   npm run migrate:events -- --env production --dry-run
 *   npm run migrate:events -- --env staging --type note --yes
 */

import 'dotenv/config';
import { exec } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const workerDir = resolve(repoRoot, 'apps', 'worker');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const ENV_CONFIG = {
	local: { database: 'antisocial-media', flags: '--local' },
	staging: { database: 'antisocial-media-staging', flags: '--remote' },
	production: { database: 'antisocial-media', flags: '--remote' },
} as const;

type Environment = keyof typeof ENV_CONFIG;

const MIGRATABLE_TYPES = ['note', 'quote', 'media', 'link', 'sleep'] as const;
type MigratableType = (typeof MIGRATABLE_TYPES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface Options {
	env: Environment;
	dryRun: boolean;
	yes: boolean;
	type?: MigratableType;
}

function parseArgs(): Options {
	const args = process.argv.slice(2);
	const options: Options = { env: 'local', dryRun: false, yes: false };

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--env': {
				const env = args[++i] as Environment;
				if (!ENV_CONFIG[env]) {
					console.error(`Invalid environment: ${env}`);
					process.exit(1);
				}
				options.env = env;
				break;
			}
			case '--dry-run':
				options.dryRun = true;
				break;
			case '--yes':
			case '-y':
				options.yes = true;
				break;
			case '--type': {
				const type = args[++i] as MigratableType;
				if (!MIGRATABLE_TYPES.includes(type)) {
					console.error(
						`Invalid type: ${type}. Must be one of: ${MIGRATABLE_TYPES.join(', ')}`
					);
					process.exit(1);
				}
				options.type = type;
				break;
			}
			case '--help':
			case '-h':
				console.log(`
Migrate Event Ledger → Denormalized Tables

Usage:
  npx tsx cli/db/migrate-events.ts --env <env> [options]

Options:
  --env <env>    Environment: local, staging, or production (required)
  --dry-run      Print SQL without executing
  --yes, -y      Skip confirmation prompt
  --type <type>  Migrate only one type (note, quote, media, link, sleep)
`);
				process.exit(0);
		}
	}

	return options;
}

async function confirm(message: string): Promise<boolean> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolve) => {
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === 'y');
		});
	});
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
		maxBuffer: 100 * 1024 * 1024,
	});

	const parsed: D1QueryResult<T>[] = JSON.parse(stdout);
	return parsed[0]?.results || [];
}

async function executeSql(
	database: string,
	flags: string,
	sqlFile: string
): Promise<void> {
	const command = `npx wrangler d1 execute ${database} ${flags} --file="${sqlFile}"`;

	await execAsync(command, {
		cwd: workerDir,
		maxBuffer: 100 * 1024 * 1024,
	});
}

/** Escape a string for SQL single-quoted literal */
function sqlEscape(value: string | undefined | null): string {
	if (value == null) return 'NULL';
	return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNum(value: number | undefined | null): string {
	if (value == null) return 'NULL';
	return String(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload → INSERT mappers
// ─────────────────────────────────────────────────────────────────────────────

interface EventRow {
	payload: string;
}

function mapNote(p: Record<string, unknown>): string {
	const id = sqlEscape(p.id as string);
	const content = sqlEscape((p.note as string) || '');
	const book_id = sqlEscape(p.book_id as string | undefined);
	const page = sqlEscape(p.page as string | undefined);
	const posted = (p.posted as boolean) ? 1 : 0;
	const tags = p.tags ? sqlEscape(JSON.stringify(p.tags)) : 'NULL';
	const replaces = sqlEscape(p.replaces as string | undefined);
	const source = sqlEscape((p.source as string) || 'web');
	const when = sqlEscape(p.when as string);
	return `INSERT OR IGNORE INTO notes (id, content, book_id, page, posted, tags, replaces, source, created_at, updated_at) VALUES (${id}, ${content}, ${book_id}, ${page}, ${posted}, ${tags}, ${replaces}, ${source}, ${when}, ${when});`;
}

function mapQuote(p: Record<string, unknown>): string {
	const id = sqlEscape(p.id as string);
	const quote = sqlEscape((p.quote as string) || '');
	const work = sqlEscape(p.work as string | undefined);
	const creator = sqlEscape(p.creator as string | undefined);
	const kind = sqlEscape(p.kind as string | undefined);
	const book_id = sqlEscape(p.book_id as string | undefined);
	const page = sqlEscape(p.page as string | undefined);
	const posted = (p.posted as boolean) ? 1 : 0;
	const tags = p.tags ? sqlEscape(JSON.stringify(p.tags)) : 'NULL';
	const replaces = sqlEscape(p.replaces as string | undefined);
	const source = sqlEscape((p.source as string) || 'web');
	const when = sqlEscape(p.when as string);
	return `INSERT OR IGNORE INTO quotes (id, quote, work, creator, kind, book_id, page, posted, tags, replaces, source, created_at, updated_at) VALUES (${id}, ${quote}, ${work}, ${creator}, ${kind}, ${book_id}, ${page}, ${posted}, ${tags}, ${replaces}, ${source}, ${when}, ${when});`;
}

function mapMedia(p: Record<string, unknown>): string {
	const id = sqlEscape(p.id as string);
	const title = sqlEscape(p.title as string | undefined);
	const url = sqlEscape(p.url as string | undefined);
	const kind = sqlEscape((p.kind as string) || 'article');
	const creator = sqlEscape(p.creator as string | undefined);
	const note = sqlEscape(p.note as string | undefined);
	const posted = (p.posted as boolean) ? 1 : 0;
	const tags = p.tags ? sqlEscape(JSON.stringify(p.tags)) : 'NULL';
	const source = sqlEscape((p.source as string) || 'web');
	const when = sqlEscape(p.when as string);
	return `INSERT OR IGNORE INTO media (id, title, url, kind, creator, note, posted, tags, source, created_at, updated_at) VALUES (${id}, ${title}, ${url}, ${kind}, ${creator}, ${note}, ${posted}, ${tags}, ${source}, ${when}, ${when});`;
}

function mapLink(p: Record<string, unknown>): string {
	const id = sqlEscape(p.id as string);
	const title = sqlEscape(p.title as string | undefined);
	const url = sqlEscape((p.url as string) || '');
	const site = sqlEscape(p.site as string | undefined);
	const og_title = sqlEscape(p.og_title as string | undefined);
	const note = sqlEscape(p.note as string | undefined);
	const posted = (p.posted as boolean) ? 1 : 0;
	const tags = p.tags ? sqlEscape(JSON.stringify(p.tags)) : 'NULL';
	const source = sqlEscape((p.source as string) || 'web');
	const when = sqlEscape(p.when as string);
	return `INSERT OR IGNORE INTO links (id, title, url, site, og_title, note, posted, tags, source, created_at, updated_at) VALUES (${id}, ${title}, ${url}, ${site}, ${og_title}, ${note}, ${posted}, ${tags}, ${source}, ${when}, ${when});`;
}

function mapSleep(p: Record<string, unknown>): string {
	const id = sqlEscape(p.id as string);
	const hours = sqlNum(p.hours as number | undefined);
	const quality = sqlNum(p.quality as number | undefined);
	const bed_time = sqlEscape(p.bed_time as string | undefined);
	const wake_time = sqlEscape(p.wake_time as string | undefined);
	const note = sqlEscape(p.note as string | undefined);
	const tags = p.tags ? sqlEscape(JSON.stringify(p.tags)) : 'NULL';
	const source = sqlEscape((p.source as string) || 'web');
	const when = sqlEscape(p.when as string);
	return `INSERT OR IGNORE INTO sleep (id, hours, quality, bed_time, wake_time, note, tags, source, created_at) VALUES (${id}, ${hours}, ${quality}, ${bed_time}, ${wake_time}, ${note}, ${tags}, ${source}, ${when});`;
}

const MAPPERS: Record<MigratableType, (p: Record<string, unknown>) => string> =
	{
		note: mapNote,
		quote: mapQuote,
		media: mapMedia,
		link: mapLink,
		sleep: mapSleep,
	};

const TARGET_TABLES: Record<MigratableType, string> = {
	note: 'notes',
	quote: 'quotes',
	media: 'media',
	link: 'links',
	sleep: 'sleep',
};

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const options = parseArgs();
	const config = ENV_CONFIG[options.env];
	const types = options.type ? [options.type] : [...MIGRATABLE_TYPES];

	console.log(`\n📦 Migrate event_ledger → denormalized tables`);
	console.log(`   Environment: ${options.env} (${config.database})`);
	console.log(`   Types: ${types.join(', ')}`);
	if (options.dryRun) console.log(`   Mode: DRY RUN`);
	console.log();

	// Fetch counts first
	for (const type of types) {
		const rows = await executeQuery<{ count: number }>(
			config.database,
			config.flags,
			`SELECT COUNT(*) as count FROM event_ledger WHERE type = '${type}'`
		);
		const destRows = await executeQuery<{ count: number }>(
			config.database,
			config.flags,
			`SELECT COUNT(*) as count FROM ${TARGET_TABLES[type]}`
		);
		console.log(
			`   ${type}: ${rows[0]?.count ?? 0} events in ledger → ${TARGET_TABLES[type]} (${destRows[0]?.count ?? 0} existing)`
		);
	}

	if (!options.yes && !options.dryRun) {
		console.log();
		const ok = await confirm(`Proceed with migration to ${options.env}?`);
		if (!ok) {
			console.log('Aborted.');
			process.exit(0);
		}
	}

	// Ensure temp directory for SQL files
	const tmpDir = resolve(repoRoot, 'local', 'tmp');
	if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

	let totalMigrated = 0;

	for (const type of types) {
		console.log(`\n── Migrating ${type} ──`);

		// Fetch all events of this type
		const events = await executeQuery<EventRow>(
			config.database,
			config.flags,
			`SELECT payload FROM event_ledger WHERE type = '${type}' ORDER BY "when" ASC`
		);

		if (events.length === 0) {
			console.log(`   No ${type} events found, skipping.`);
			continue;
		}

		console.log(`   Fetched ${events.length} events`);

		// Generate INSERT statements
		const mapper = MAPPERS[type];
		const statements: string[] = [];
		let errors = 0;

		for (const row of events) {
			try {
				const payload = JSON.parse(row.payload) as Record<
					string,
					unknown
				>;
				statements.push(mapper(payload));
			} catch (e) {
				errors++;
				console.error(`   ⚠ Failed to parse event: ${e}`);
			}
		}

		if (errors > 0) {
			console.log(`   ⚠ ${errors} events failed to parse`);
		}

		if (statements.length === 0) {
			console.log(`   No valid statements generated, skipping.`);
			continue;
		}

		// Write SQL file (no explicit transaction — D1 remote handles this internally)
		const sql = `-- Migration: event_ledger ${type} → ${TARGET_TABLES[type]}
-- Generated: ${new Date().toISOString()}
-- Count: ${statements.length} rows

${statements.join('\n')}
`;

		const sqlFile = resolve(tmpDir, `migrate-${type}.sql`);
		writeFileSync(sqlFile, sql);

		if (options.dryRun) {
			console.log(`   📄 SQL written to ${sqlFile}`);
			console.log(
				`   Would insert ${statements.length} rows into ${TARGET_TABLES[type]}`
			);
		} else {
			console.log(`   Executing ${statements.length} inserts...`);
			try {
				await executeSql(config.database, config.flags, sqlFile);
				console.log(
					`   ✓ Inserted ${statements.length} rows into ${TARGET_TABLES[type]}`
				);
				totalMigrated += statements.length;
			} catch (e) {
				console.error(`   ✗ Failed: ${e}`);
				console.log(`   SQL file saved at: ${sqlFile}`);
			}
		}
	}

	// Verify counts
	if (!options.dryRun && totalMigrated > 0) {
		console.log(`\n── Verification ──`);
		for (const type of types) {
			const src = await executeQuery<{ count: number }>(
				config.database,
				config.flags,
				`SELECT COUNT(*) as count FROM event_ledger WHERE type = '${type}'`
			);
			const dest = await executeQuery<{ count: number }>(
				config.database,
				config.flags,
				`SELECT COUNT(*) as count FROM ${TARGET_TABLES[type]}`
			);
			const srcCount = src[0]?.count ?? 0;
			const destCount = dest[0]?.count ?? 0;
			const match = srcCount === destCount ? '✓' : '⚠ MISMATCH';
			console.log(
				`   ${type}: ledger=${srcCount} → ${TARGET_TABLES[type]}=${destCount} ${match}`
			);
		}
	}

	console.log(
		`\n${options.dryRun ? '🔍 Dry run complete.' : `✅ Migration complete. ${totalMigrated} rows migrated.`}`
	);
}

main().catch((e) => {
	console.error('Migration failed:', e);
	process.exit(1);
});
