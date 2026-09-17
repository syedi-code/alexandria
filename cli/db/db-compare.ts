#!/usr/bin/env tsx
/**
 * D1 Database Comparison Tool
 *
 * Compares metadata between two D1 database environments to identify
 * schema differences, row count deltas, and data freshness gaps.
 *
 * Usage:
 *   npx tsx cli/db/db-compare.ts <env1> <env2> [options]
 *
 * Arguments:
 *   env1, env2    Environments to compare: local, staging, or production
 *
 * Options:
 *   --json        Output as JSON instead of table format
 *
 * Examples:
 *   npx tsx cli/db/db-compare.ts local staging
 *   npx tsx cli/db/db-compare.ts staging production
 *   npx tsx cli/db/db-compare.ts local production --json
 */

import 'dotenv/config';
import { collectMetadata, type DatabaseMetadata } from './db-metadata.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Environment = 'local' | 'staging' | 'production';

interface Options {
	env1: Environment;
	env2: Environment;
	json: boolean;
}

interface SchemaDiff {
	tablesOnlyIn1: string[];
	tablesOnlyIn2: string[];
	indexesOnlyIn1: string[];
	indexesOnlyIn2: string[];
	columnDiffs: {
		table: string;
		onlyIn1: string[];
		onlyIn2: string[];
	}[];
}

interface RowCountDiff {
	table: string;
	count1: number;
	count2: number;
	delta: number;
	percentDiff: string;
}

interface FreshnessDiff {
	metric: string;
	value1: string | number | undefined;
	value2: string | number | undefined;
	status: 'match' | 'env1-newer' | 'env2-newer' | 'differs';
}

interface ComparisonResult {
	env1: string;
	env2: string;
	comparedAt: string;
	schema: SchemaDiff;
	rowCounts: RowCountDiff[];
	freshness: FreshnessDiff[];
	summary: {
		schemaMatches: boolean;
		totalRowDiff: number;
		issues: string[];
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(): Options {
	const args = process.argv.slice(2);

	if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
		console.log(`
D1 Database Comparison Tool

Usage:
  npx tsx cli/db/db-compare.ts <env1> <env2> [options]

Arguments:
  env1, env2    Environments to compare: local, staging, or production

Options:
  --json        Output as JSON instead of table format
  --help, -h    Show this help message

Examples:
  npx tsx cli/db/db-compare.ts local staging
  npx tsx cli/db/db-compare.ts staging production
  npx tsx cli/db/db-compare.ts local production --json
`);
		process.exit(0);
	}

	const envArgs = args.filter((a) => !a.startsWith('--'));
	const validEnvs = ['local', 'staging', 'production'];

	if (envArgs.length < 2) {
		console.error('Error: Two environments required for comparison');
		console.error('Usage: npx tsx cli/db/db-compare.ts <env1> <env2>');
		console.error('Valid environments: local, staging, production');
		process.exit(1);
	}

	const [env1, env2] = envArgs as [Environment, Environment];

	if (!validEnvs.includes(env1) || !validEnvs.includes(env2)) {
		console.error('Invalid environment specified');
		console.error('Valid environments: local, staging, production');
		process.exit(1);
	}

	if (env1 === env2) {
		console.error('Error: Cannot compare an environment with itself');
		process.exit(1);
	}

	return {
		env1,
		env2,
		json: args.includes('--json'),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison Logic
// ─────────────────────────────────────────────────────────────────────────────

function compareSchemata(
	meta1: DatabaseMetadata,
	meta2: DatabaseMetadata
): SchemaDiff {
	const tables1 = new Set(meta1.tables.map((t) => t.name));
	const tables2 = new Set(meta2.tables.map((t) => t.name));

	const indexes1 = new Set(meta1.indexes.map((i) => i.name));
	const indexes2 = new Set(meta2.indexes.map((i) => i.name));

	const tablesOnlyIn1 = [...tables1].filter((t) => !tables2.has(t));
	const tablesOnlyIn2 = [...tables2].filter((t) => !tables1.has(t));

	const indexesOnlyIn1 = [...indexes1].filter((i) => !indexes2.has(i));
	const indexesOnlyIn2 = [...indexes2].filter((i) => !indexes1.has(i));

	// Compare columns for shared tables
	const columnDiffs: SchemaDiff['columnDiffs'] = [];
	const sharedTables = [...tables1].filter((t) => tables2.has(t));

	for (const tableName of sharedTables) {
		const table1 = meta1.tables.find((t) => t.name === tableName)!;
		const table2 = meta2.tables.find((t) => t.name === tableName)!;

		const cols1 = new Set(table1.columns.map((c) => c.name));
		const cols2 = new Set(table2.columns.map((c) => c.name));

		const onlyIn1 = [...cols1].filter((c) => !cols2.has(c));
		const onlyIn2 = [...cols2].filter((c) => !cols1.has(c));

		if (onlyIn1.length > 0 || onlyIn2.length > 0) {
			columnDiffs.push({ table: tableName, onlyIn1, onlyIn2 });
		}
	}

	return {
		tablesOnlyIn1,
		tablesOnlyIn2,
		indexesOnlyIn1,
		indexesOnlyIn2,
		columnDiffs,
	};
}

function compareRowCounts(
	meta1: DatabaseMetadata,
	meta2: DatabaseMetadata
): RowCountDiff[] {
	const allTables = new Set([
		...Object.keys(meta1.rowCounts),
		...Object.keys(meta2.rowCounts),
	]);

	return [...allTables].map((table) => {
		const count1 = meta1.rowCounts[table] ?? 0;
		const count2 = meta2.rowCounts[table] ?? 0;
		const delta = count2 - count1;
		const percentDiff =
			count1 === 0
				? count2 === 0
					? '0%'
					: '+∞'
				: `${((delta / count1) * 100).toFixed(1)}%`;

		return { table, count1, count2, delta, percentDiff };
	});
}

function compareFreshness(
	meta1: DatabaseMetadata,
	meta2: DatabaseMetadata
): FreshnessDiff[] {
	const compareDates = (
		v1: string | undefined,
		v2: string | undefined
	): FreshnessDiff['status'] => {
		if (v1 === v2) return 'match';
		if (!v1) return 'env2-newer';
		if (!v2) return 'env1-newer';
		return new Date(v1) > new Date(v2) ? 'env1-newer' : 'env2-newer';
	};

	return [
		{
			metric: 'Latest Event',
			value1: meta1.freshness.latestEvent,
			value2: meta2.freshness.latestEvent,
			status: compareDates(
				meta1.freshness.latestEvent,
				meta2.freshness.latestEvent
			),
		},
		{
			metric: 'Latest Weather',
			value1: meta1.freshness.latestWeather,
			value2: meta2.freshness.latestWeather,
			status: compareDates(
				meta1.freshness.latestWeather,
				meta2.freshness.latestWeather
			),
		},
		{
			metric: 'Latest News',
			value1: meta1.freshness.latestNews,
			value2: meta2.freshness.latestNews,
			status: compareDates(
				meta1.freshness.latestNews,
				meta2.freshness.latestNews
			),
		},
		{
			metric: 'Book Count',
			value1: meta1.freshness.bookCount,
			value2: meta2.freshness.bookCount,
			status:
				meta1.freshness.bookCount === meta2.freshness.bookCount
					? 'match'
					: 'differs',
		},
	];
}

function generateSummary(
	schema: SchemaDiff,
	rowCounts: RowCountDiff[]
): ComparisonResult['summary'] {
	const issues: string[] = [];

	const schemaMatches =
		schema.tablesOnlyIn1.length === 0 &&
		schema.tablesOnlyIn2.length === 0 &&
		schema.indexesOnlyIn1.length === 0 &&
		schema.indexesOnlyIn2.length === 0 &&
		schema.columnDiffs.length === 0;

	if (!schemaMatches) {
		if (schema.tablesOnlyIn1.length > 0) {
			issues.push(
				`Missing tables in env2: ${schema.tablesOnlyIn1.join(', ')}`
			);
		}
		if (schema.tablesOnlyIn2.length > 0) {
			issues.push(
				`Missing tables in env1: ${schema.tablesOnlyIn2.join(', ')}`
			);
		}
		if (schema.columnDiffs.length > 0) {
			issues.push(
				`Column differences in: ${schema.columnDiffs.map((d) => d.table).join(', ')}`
			);
		}
	}

	const totalRowDiff = rowCounts.reduce(
		(sum, r) => sum + Math.abs(r.delta),
		0
	);

	return { schemaMatches, totalRowDiff, issues };
}

async function compare(
	env1: Environment,
	env2: Environment
): Promise<ComparisonResult> {
	const [meta1, meta2] = await Promise.all([
		collectMetadata(env1),
		collectMetadata(env2),
	]);

	const schema = compareSchemata(meta1, meta2);
	const rowCounts = compareRowCounts(meta1, meta2);
	const freshness = compareFreshness(meta1, meta2);
	const summary = generateSummary(schema, rowCounts);

	return {
		env1,
		env2,
		comparedAt: new Date().toISOString(),
		schema,
		rowCounts,
		freshness,
		summary,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Output Formatting
// ─────────────────────────────────────────────────────────────────────────────

function formatComparison(result: ComparisonResult): void {
	const { env1, env2, schema, rowCounts, freshness, summary, comparedAt } =
		result;

	const env1Label = env1.toUpperCase().padEnd(12);
	const env2Label = env2.toUpperCase().padEnd(12);

	console.log(
		'\n╔════════════════════════════════════════════════════════════════╗'
	);
	console.log(
		`║  D1 Database Comparison                                        ║`
	);
	console.log(
		'╠════════════════════════════════════════════════════════════════╣'
	);
	console.log(`║  Comparing: ${env1} ↔ ${env2}`.padEnd(65) + '║');
	console.log(`║  Time:      ${comparedAt}`.padEnd(65) + '║');
	console.log(
		'╚════════════════════════════════════════════════════════════════╝\n'
	);

	// Summary
	const statusIcon = summary.schemaMatches ? '✅' : '⚠️';
	console.log(
		`${statusIcon} Schema Match: ${summary.schemaMatches ? 'YES' : 'NO'}`
	);
	console.log(
		`📊 Total Row Difference: ${summary.totalRowDiff.toLocaleString()}\n`
	);

	if (summary.issues.length > 0) {
		console.log('⚠️  Issues:');
		summary.issues.forEach((issue) => console.log(`   • ${issue}`));
		console.log();
	}

	// Schema Differences
	if (!summary.schemaMatches) {
		console.log(
			'┌─────────────────────────────────────────────────────────────────┐'
		);
		console.log(
			'│  Schema Differences                                             │'
		);
		console.log(
			'└─────────────────────────────────────────────────────────────────┘'
		);

		if (schema.tablesOnlyIn1.length > 0) {
			console.log(`\n  Tables only in ${env1}:`);
			schema.tablesOnlyIn1.forEach((t) => console.log(`    - ${t}`));
		}

		if (schema.tablesOnlyIn2.length > 0) {
			console.log(`\n  Tables only in ${env2}:`);
			schema.tablesOnlyIn2.forEach((t) => console.log(`    - ${t}`));
		}

		if (schema.columnDiffs.length > 0) {
			console.log('\n  Column Differences:');
			schema.columnDiffs.forEach((diff) => {
				console.log(`    ${diff.table}:`);
				if (diff.onlyIn1.length > 0) {
					console.log(
						`      Only in ${env1}: ${diff.onlyIn1.join(', ')}`
					);
				}
				if (diff.onlyIn2.length > 0) {
					console.log(
						`      Only in ${env2}: ${diff.onlyIn2.join(', ')}`
					);
				}
			});
		}
		console.log();
	}

	// Row Counts
	console.log(
		'┌─────────────────────────────────────────────────────────────────┐'
	);
	console.log(
		'│  Row Counts                                                     │'
	);
	console.log(
		'├───────────────────┬─────────────┬─────────────┬─────────────────┤'
	);
	console.log(
		`│  Table            │  ${env1Label}│  ${env2Label}│  Delta          │`
	);
	console.log(
		'├───────────────────┼─────────────┼─────────────┼─────────────────┤'
	);

	for (const row of rowCounts) {
		const table = row.table.padEnd(17);
		const c1 = row.count1.toLocaleString().padEnd(11);
		const c2 = row.count2.toLocaleString().padEnd(11);
		const delta =
			`${row.delta >= 0 ? '+' : ''}${row.delta} (${row.percentDiff})`.padEnd(
				15
			);
		console.log(`│  ${table}│  ${c1}│  ${c2}│  ${delta}│`);
	}

	console.log(
		'└───────────────────┴─────────────┴─────────────┴─────────────────┘\n'
	);

	// Data Freshness
	console.log(
		'┌─────────────────────────────────────────────────────────────────┐'
	);
	console.log(
		'│  Data Freshness                                                 │'
	);
	console.log(
		'├──────────────────┬───────────────────────┬──────────────────────┤'
	);
	console.log(
		`│  Metric          │  ${env1Label.padEnd(19)}  │  ${env2Label.padEnd(18)}│`
	);
	console.log(
		'├──────────────────┼───────────────────────┼──────────────────────┤'
	);

	for (const f of freshness) {
		const metric = f.metric.padEnd(16);
		const v1 = (f.value1?.toString() || 'N/A').slice(0, 19).padEnd(21);
		const v2 = (f.value2?.toString() || 'N/A').slice(0, 18).padEnd(20);
		console.log(`│  ${metric}│  ${v1}│  ${v2}│`);
	}

	console.log(
		'└──────────────────┴───────────────────────┴──────────────────────┘\n'
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const options = parseArgs();

	if (!options.json) {
		console.log(`\n🔍 Comparing ${options.env1} ↔ ${options.env2}...`);
	}

	try {
		const result = await compare(options.env1, options.env2);

		if (options.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			formatComparison(result);
		}
	} catch (error) {
		console.error('Error comparing databases:', error);
		process.exit(1);
	}
}

main();
