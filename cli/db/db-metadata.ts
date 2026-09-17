#!/usr/bin/env tsx
/**
 * D1 Database Metadata Tool
 *
 * Retrieves metadata about a D1 database including schema, row counts,
 * and data freshness indicators.
 *
 * Usage:
 *   npx tsx cli/db/db-metadata.ts [options]
 *
 * Options:
 *   --env <env>    Environment: local, staging, or production (default: local)
 *   --json         Output as JSON instead of table format
 *
 * Examples:
 *   npx tsx cli/db/db-metadata.ts --env local
 *   npx tsx cli/db/db-metadata.ts --env staging --json
 *   npx tsx cli/db/db-metadata.ts --env production
 */

import 'dotenv/config';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface TableInfo {
	name: string;
	sql: string;
	columns: ColumnInfo[];
}

interface ColumnInfo {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

interface IndexInfo {
	name: string;
	tbl_name: string;
	sql: string | null;
}

interface RowCounts {
	[table: string]: number;
}

interface DataFreshness {
	latestEvent?: string;
	latestWeather?: string;
	latestNews?: string;
	bookCount?: number;
}

export interface DatabaseMetadata {
	environment: string;
	database: string;
	tables: TableInfo[];
	indexes: IndexInfo[];
	rowCounts: RowCounts;
	freshness: DataFreshness;
	collectedAt: string;
}

interface Options {
	env: 'local' | 'staging' | 'production';
	json: boolean;
}

interface D1QueryResult<T> {
	success: boolean;
	results: T[];
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(): Options {
	const args = process.argv.slice(2);
	const options: Options = {
		env: 'local',
		json: false,
	};

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--env': {
				const env = args[++i] as Options['env'];
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
D1 Database Metadata Tool

Usage:
  npx tsx cli/db/db-metadata.ts [options]

Options:
  --env <env>    Environment: local, staging, or production (default: local)
  --json         Output as JSON instead of table format
  --help, -h     Show this help message

Examples:
  npx tsx cli/db/db-metadata.ts --env local
  npx tsx cli/db/db-metadata.ts --env staging --json
  npx tsx cli/db/db-metadata.ts --env production
`);
				process.exit(0);
		}
	}

	return options;
}

async function executeQuery<T>(
	database: string,
	flags: string,
	query: string
): Promise<D1QueryResult<T>[]> {
	// Normalize whitespace and escape for shell
	const normalizedQuery = query.replace(/\s+/g, ' ').trim();
	const escapedQuery = normalizedQuery.replace(/"/g, '\\"');
	const command = `npx wrangler d1 execute ${database} ${flags} --json --command="${escapedQuery}"`;

	try {
		const { stdout } = await execAsync(command, {
			maxBuffer: 10 * 1024 * 1024,
		});
		return JSON.parse(stdout);
	} catch {
		// Return empty result on error (table might not exist)
		return [{ success: false, results: [] }];
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata Collection
// ─────────────────────────────────────────────────────────────────────────────

async function getTables(
	database: string,
	flags: string
): Promise<TableInfo[]> {
	const query = `
		SELECT name, sql FROM sqlite_master 
		WHERE type = 'table' 
		AND name NOT LIKE 'sqlite_%' 
		AND name NOT LIKE '_cf_%'
		AND name NOT LIKE 'd1_%'
		ORDER BY name
	`;

	const result = await executeQuery<{ name: string; sql: string }>(
		database,
		flags,
		query
	);
	const tables: TableInfo[] = [];

	for (const row of result[0]?.results || []) {
		// Get column info for each table
		const columnsResult = await executeQuery<ColumnInfo>(
			database,
			flags,
			`PRAGMA table_info(${row.name})`
		);

		tables.push({
			name: row.name,
			sql: row.sql,
			columns: columnsResult[0]?.results || [],
		});
	}

	return tables;
}

async function getIndexes(
	database: string,
	flags: string
): Promise<IndexInfo[]> {
	const query = `
		SELECT name, tbl_name, sql FROM sqlite_master 
		WHERE type = 'index' 
		AND name NOT LIKE 'sqlite_%'
		AND name NOT LIKE '_cf_%'
		ORDER BY tbl_name, name
	`;

	const result = await executeQuery<IndexInfo>(database, flags, query);
	return result[0]?.results || [];
}

async function getRowCounts(
	database: string,
	flags: string,
	tables: TableInfo[]
): Promise<RowCounts> {
	const counts: RowCounts = {};

	for (const table of tables) {
		const result = await executeQuery<{ count: number }>(
			database,
			flags,
			`SELECT COUNT(*) as count FROM ${table.name}`
		);
		counts[table.name] = result[0]?.results[0]?.count ?? 0;
	}

	return counts;
}

async function getDataFreshness(
	database: string,
	flags: string
): Promise<DataFreshness> {
	const freshness: DataFreshness = {};

	// Latest event
	const eventResult = await executeQuery<{ latest: string }>(
		database,
		flags,
		`SELECT MAX("when") as latest FROM event_ledger`
	);
	freshness.latestEvent = eventResult[0]?.results[0]?.latest || undefined;

	// Latest weather
	const weatherResult = await executeQuery<{ latest: string }>(
		database,
		flags,
		`SELECT MAX(date) as latest FROM weather_daily`
	);
	freshness.latestWeather = weatherResult[0]?.results[0]?.latest || undefined;

	// Latest news
	const newsResult = await executeQuery<{ latest: string }>(
		database,
		flags,
		`SELECT MAX(date) as latest FROM news_daily`
	);
	freshness.latestNews = newsResult[0]?.results[0]?.latest || undefined;

	// Book count
	const bookResult = await executeQuery<{ count: number }>(
		database,
		flags,
		`SELECT COUNT(*) as count FROM books`
	);
	freshness.bookCount = bookResult[0]?.results[0]?.count ?? 0;

	return freshness;
}

export async function collectMetadata(
	env: Options['env']
): Promise<DatabaseMetadata> {
	const config = ENV_CONFIG[env];
	const { database, flags } = config;

	const tables = await getTables(database, flags);
	const indexes = await getIndexes(database, flags);
	const rowCounts = await getRowCounts(database, flags, tables);
	const freshness = await getDataFreshness(database, flags);

	return {
		environment: env,
		database,
		tables,
		indexes,
		rowCounts,
		freshness,
		collectedAt: new Date().toISOString(),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Output Formatting
// ─────────────────────────────────────────────────────────────────────────────

function formatTable(metadata: DatabaseMetadata): void {
	const {
		environment,
		database,
		tables,
		indexes,
		rowCounts,
		freshness,
		collectedAt,
	} = metadata;

	console.log(
		'\n╔════════════════════════════════════════════════════════════════╗'
	);
	console.log(
		`║  D1 Database Metadata                                          ║`
	);
	console.log(
		'╠════════════════════════════════════════════════════════════════╣'
	);
	console.log(`║  Environment:  ${environment.padEnd(48)}║`);
	console.log(`║  Database:     ${database.padEnd(48)}║`);
	console.log(`║  Collected:    ${collectedAt.padEnd(48)}║`);
	console.log(
		'╚════════════════════════════════════════════════════════════════╝\n'
	);

	// Tables and Row Counts
	console.log(
		'┌─────────────────────────────────────────────────────────────────┐'
	);
	console.log(
		'│  Tables                                                         │'
	);
	console.log(
		'├─────────────────────────┬─────────────────────┬─────────────────┤'
	);
	console.log(
		'│  Name                   │  Columns            │  Rows           │'
	);
	console.log(
		'├─────────────────────────┼─────────────────────┼─────────────────┤'
	);

	for (const table of tables) {
		const name = table.name.padEnd(21);
		const cols = table.columns.length.toString().padEnd(19);
		const rows = (rowCounts[table.name] ?? 0).toLocaleString().padEnd(15);
		console.log(`│  ${name}  │  ${cols}  │  ${rows}│`);
	}

	console.log(
		'└─────────────────────────┴─────────────────────┴─────────────────┘\n'
	);

	// Indexes
	if (indexes.length > 0) {
		console.log(
			'┌─────────────────────────────────────────────────────────────────┐'
		);
		console.log(
			'│  Indexes                                                        │'
		);
		console.log(
			'├─────────────────────────────────────┬───────────────────────────┤'
		);
		console.log(
			'│  Name                               │  Table                    │'
		);
		console.log(
			'├─────────────────────────────────────┼───────────────────────────┤'
		);

		for (const index of indexes) {
			const name = index.name.padEnd(35);
			const table = index.tbl_name.padEnd(25);
			console.log(`│  ${name}│  ${table}│`);
		}

		console.log(
			'└─────────────────────────────────────┴───────────────────────────┘\n'
		);
	}

	// Data Freshness
	console.log(
		'┌─────────────────────────────────────────────────────────────────┐'
	);
	console.log(
		'│  Data Freshness                                                 │'
	);
	console.log(
		'├─────────────────────────────────────────────────────────────────┤'
	);
	console.log(
		`│  Latest Event:    ${(freshness.latestEvent || 'N/A').padEnd(45)}│`
	);
	console.log(
		`│  Latest Weather:  ${(freshness.latestWeather || 'N/A').padEnd(45)}│`
	);
	console.log(
		`│  Latest News:     ${(freshness.latestNews || 'N/A').padEnd(45)}│`
	);
	console.log(
		`│  Total Books:     ${(freshness.bookCount?.toString() || '0').padEnd(45)}│`
	);
	console.log(
		'└─────────────────────────────────────────────────────────────────┘\n'
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const options = parseArgs();

	if (!options.json) {
		console.log(
			`\n🔍 Collecting metadata for ${options.env} environment...`
		);
	}

	try {
		const metadata = await collectMetadata(options.env);

		if (options.json) {
			console.log(JSON.stringify(metadata, null, 2));
		} else {
			formatTable(metadata);
		}
	} catch (error) {
		console.error('Error collecting metadata:', error);
		process.exit(1);
	}
}

// Only run main when executed directly (not when imported)
const scriptPath = process.argv[1]?.replace(/\\/g, '/');
const isMainModule =
	scriptPath && import.meta.url.endsWith(scriptPath.split('/').pop() || '');
if (isMainModule) {
	main();
}
