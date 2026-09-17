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
import {
	ENVIRONMENTS,
	isEnvironment,
	query,
	type Environment,
} from '../wrangler.js';

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
	env: Environment;
	json: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Metadata Collection
// ─────────────────────────────────────────────────────────────────────────────

async function getTables(env: Environment): Promise<TableInfo[]> {
	const rows = await query<{ name: string; sql: string }>(env, 'db', {
		sql: `SELECT name, sql FROM sqlite_master
		       WHERE type = 'table'
		         AND name NOT LIKE 'sqlite_%'
		         AND name NOT LIKE '_cf_%'
		         AND name NOT LIKE 'd1_%'
		       ORDER BY name`,
	});

	const tables: TableInfo[] = [];
	for (const row of rows) {
		tables.push({
			name: row.name,
			sql: row.sql,
			columns: await query<ColumnInfo>(env, 'db', {
				sql: `PRAGMA table_info(${row.name})`,
			}),
		});
	}
	return tables;
}

const getIndexes = (env: Environment): Promise<IndexInfo[]> =>
	query<IndexInfo>(env, 'db', {
		sql: `SELECT name, tbl_name, sql FROM sqlite_master
		       WHERE type = 'index'
		         AND name NOT LIKE 'sqlite_%'
		         AND name NOT LIKE '_cf_%'
		       ORDER BY tbl_name, name`,
	});

async function getRowCounts(
	env: Environment,
	tables: TableInfo[]
): Promise<RowCounts> {
	const counts: RowCounts = {};
	for (const table of tables) {
		const [row] = await query<{ count: number }>(env, 'db', {
			sql: `SELECT COUNT(*) as count FROM ${table.name}`,
		});
		counts[table.name] = row?.count ?? 0;
	}
	return counts;
}

async function getDataFreshness(env: Environment): Promise<DataFreshness> {
	const latest = async (table: string, column: string) => {
		const [row] = await query<{ latest: string | null }>(env, 'db', {
			sql: `SELECT MAX(${column}) as latest FROM ${table}`,
		});
		return row?.latest || undefined;
	};
	const [works] = await query<{ count: number }>(env, 'db', {
		sql: `SELECT COUNT(*) as count FROM works WHERE deleted_at IS NULL`,
	});

	return {
		latestEvent: await latest('event_ledger', '"when"'),
		latestWeather: await latest('weather_daily', 'date'),
		latestNews: await latest('news_daily', 'date'),
		bookCount: works?.count ?? 0,
	};
}

export async function collectMetadata(
	env: Environment
): Promise<DatabaseMetadata> {
	const tables = await getTables(env);

	return {
		environment: env,
		database: ENVIRONMENTS[env].db,
		tables,
		indexes: await getIndexes(env),
		rowCounts: await getRowCounts(env, tables),
		freshness: await getDataFreshness(env),
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
