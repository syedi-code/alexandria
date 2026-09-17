#!/usr/bin/env tsx
/**
 * D1 SQL Execution Tool
 *
 * Executes SQL files against local, staging, or production D1 databases.
 *
 * Usage:
 *   npx tsx cli/db/execute-sql.ts --env <env> <sql-file>
 *
 * Options:
 *   --env <env>    Environment: local, staging, or production (required)
 *   --dry-run      Show command without executing
 *   --yes          Skip confirmation prompt for production
 *
 * Examples:
 *   npx tsx cli/db/execute-sql.ts --env local 0005_page_references.sql
 *   npx tsx cli/db/execute-sql.ts --env staging sql/migrations/0005_page_references.sql
 *   npx tsx cli/db/execute-sql.ts --env production 0005_page_references.sql --yes
 */

import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, basename, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import {
	ENVIRONMENTS,
	executeSqlFile,
	isEnvironment,
	query,
	type Environment,
} from '../wrangler.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function printUsage(): void {
	console.log(`
Usage: npx tsx cli/db/execute-sql.ts --env <env> <sql-file>

Options:
  --env <env>    Environment: local, staging, or production (required)
  --output <file> Save query results to a JSON file (for SELECT queries)
  --dry-run      Show command without executing
  --yes, -y      Skip confirmation prompt for production

Arguments:
  <sql-file>     SQL file to execute. Can be:
                 - Just filename (e.g., 0005_page_references.sql) - looks in sql/migrations/
                 - Relative path (e.g., cli/setup/schema/002-books.sql)
                 - Absolute path

Examples:
  npm run sql:local -- 0005_page_references.sql
  npm run sql:staging -- 0005_page_references.sql
  npm run sql:production -- 0005_page_references.sql
`);
}

function resolveSqlFile(input: string): string | null {
	// If it's an absolute path, use it directly
	if (isAbsolute(input)) {
		return existsSync(input) ? input : null;
	}

	// Try as-is (relative to cwd)
	const cwdPath = resolve(process.cwd(), input);
	if (existsSync(cwdPath)) {
		return cwdPath;
	}

	// Try in sql/migrations/ folder
	const migrationsPath = resolve(process.cwd(), 'sql', 'migrations', input);
	if (existsSync(migrationsPath)) {
		return migrationsPath;
	}

	// Try relative to repo root (for when run from cli/ folder)
	const rootPath = resolve(process.cwd(), '..', input);
	if (existsSync(rootPath)) {
		return rootPath;
	}

	const rootMigrationsPath = resolve(
		process.cwd(),
		'..',
		'sql',
		'migrations',
		input
	);
	if (existsSync(rootMigrationsPath)) {
		return rootMigrationsPath;
	}

	return null;
}

async function confirm(message: string): Promise<boolean> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(message, (answer) => {
			rl.close();
			resolve(
				answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes'
			);
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	// Parse arguments
	let env: Environment | null = null;
	let sqlFile: string | null = null;
	let outputFile: string | null = null;
	let dryRun = false;
	let skipConfirm = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--env' && args[i + 1]) {
			const envArg = args[++i];
			if (isEnvironment(envArg)) {
				env = envArg;
			} else {
				console.error(`❌ Invalid environment: ${envArg}`);
				console.error('   Valid options: local, staging, production');
				process.exit(1);
			}
		} else if (arg === '--dry-run') {
			dryRun = true;
		} else if (arg === '--output' && args[i + 1]) {
			outputFile = args[++i];
		} else if (arg === '--yes' || arg === '-y') {
			skipConfirm = true;
		} else if (arg === '--help' || arg === '-h') {
			printUsage();
			process.exit(0);
		} else if (!arg.startsWith('-')) {
			sqlFile = arg;
		}
	}

	// Validate required arguments
	if (!env) {
		console.error('❌ Missing required --env argument');
		printUsage();
		process.exit(1);
	}

	if (!sqlFile) {
		console.error('❌ Missing SQL file argument');
		printUsage();
		process.exit(1);
	}

	// Resolve SQL file path
	const repoRoot = resolve(import.meta.dirname, '..', '..');
	const resolvedPath = resolveSqlFile(sqlFile);
	if (!resolvedPath) {
		console.error(`❌ SQL file not found: ${sqlFile}`);
		console.error('   Searched in:');
		console.error(`   - ${resolve(process.cwd(), sqlFile)}`);
		console.error(`   - ${resolve(process.cwd(), 'migrations', sqlFile)}`);
		process.exit(1);
	}

	// Show what we're about to do
	console.log('');
	console.log(
		'┌─────────────────────────────────────────────────────────────┐'
	);
	console.log(
		'│  D1 SQL Execution                                           │'
	);
	console.log(
		'├─────────────────────────────────────────────────────────────┤'
	);
	console.log(`│  Environment: ${env.toUpperCase().padEnd(45)}│`);
	console.log(`│  Database:    ${ENVIRONMENTS[env].db.padEnd(45)}│`);
	console.log(`│  File:        ${basename(resolvedPath).padEnd(45)}│`);
	console.log(
		'└─────────────────────────────────────────────────────────────┘'
	);
	console.log('');

	// Show SQL preview
	const sqlContent = readFileSync(resolvedPath, 'utf-8');
	const previewLines = sqlContent.split('\n').slice(0, 15);
	console.log('SQL Preview:');
	console.log('─'.repeat(60));
	previewLines.forEach((line) => console.log(`  ${line}`));
	if (sqlContent.split('\n').length > 15) {
		console.log('  ...');
	}
	console.log('─'.repeat(60));
	console.log('');

	// Production confirmation
	if (env === 'production' && !skipConfirm && !dryRun) {
		console.log(
			'⚠️  WARNING: You are about to execute SQL against PRODUCTION'
		);
		console.log('');
		const confirmed = await confirm(
			'Are you sure you want to continue? (y/N): '
		);
		if (!confirmed) {
			console.log('❌ Aborted');
			process.exit(1);
		}
		console.log('');
	}

	if (dryRun) {
		console.log('Dry run: nothing was executed.');
		console.log(`   ${resolvedPath} would run against ${env}.`);
		process.exit(0);
	}

	console.log(`Executing SQL against ${env}...`);
	console.log('');

	try {
		if (outputFile) {
			// Results only come back from --command; a remote --file goes through
			// D1's import API, which reports a summary and no rows.
			const rows = await query(env, 'db', {
				sql: readFileSync(resolvedPath, 'utf-8').replace(/--.*$/gm, ''),
			});
			const outputPath = resolve(repoRoot, outputFile);
			writeFileSync(outputPath, JSON.stringify(rows, null, 2));
			console.log(`Results saved to: ${outputPath}`);
			console.log(`   ${rows.length} row(s) returned`);
			if (rows.length > 0 && rows.length <= 20) console.table(rows);
		} else {
			const written = await executeSqlFile(env, 'db', resolvedPath);
			if (written !== null) console.log(`   ${written} rows written`);
		}
		console.log('');
		console.log(`SQL executed successfully on ${env}`);
	} catch (error) {
		console.error('');
		console.error('Execution failed');
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

main().catch((e) => {
	console.error('Fatal error:', e);
	process.exit(1);
});
