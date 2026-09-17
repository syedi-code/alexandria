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
		flags: '--env staging --remote',
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
			if (
				envArg === 'local' ||
				envArg === 'staging' ||
				envArg === 'production'
			) {
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
	const resolvedPath = resolveSqlFile(sqlFile);
	if (!resolvedPath) {
		console.error(`❌ SQL file not found: ${sqlFile}`);
		console.error('   Searched in:');
		console.error(`   - ${resolve(process.cwd(), sqlFile)}`);
		console.error(`   - ${resolve(process.cwd(), 'migrations', sqlFile)}`);
		process.exit(1);
	}

	// Get environment config
	const config = ENV_CONFIG[env];

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
	console.log(`│  Database:    ${config.database.padEnd(45)}│`);
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

	// Build command
	// We need to run from apps/worker directory for wrangler.toml resolution
	// Script may run from cli/ dir (workspace) or repo root, so find repo root first
	const scriptDir = new URL('.', import.meta.url).pathname.replace(
		/^\/([A-Z]:)/,
		'$1'
	); // Fix Windows path
	const repoRoot = resolve(scriptDir, '..', '..');
	const workerDir = resolve(repoRoot, 'apps', 'worker');
	const relativeFilePath = resolve(resolvedPath); // Absolute path works fine

	const command = `npx wrangler d1 execute ${config.database} ${config.flags} --file="${relativeFilePath}"`;

	if (dryRun) {
		console.log('🔍 Dry run - command that would be executed:');
		console.log(`   cd ${workerDir}`);
		console.log(`   ${command}`);
		console.log('');
		process.exit(0);
	}

	// Execute
	console.log(`⏳ Executing SQL against ${env}...`);
	console.log('');

	// Change to worker directory for wrangler.toml resolution
	const originalCwd = process.cwd();
	process.chdir(workerDir);

	try {
		const { execSync } = await import('node:child_process');
		const { writeFileSync, readFileSync } = await import('node:fs');

		if (outputFile) {
			// For capturing JSON output, we need to use --command instead of --file
			// Read the SQL file content and pass it as a command
			const sqlContent = readFileSync(relativeFilePath, 'utf-8')
				.replace(/--.*$/gm, '') // Remove SQL comments
				.replace(/\s+/g, ' ') // Collapse whitespace
				.trim();

			// Escape double quotes for shell
			const escapedSql = sqlContent.replace(/"/g, '\\"');
			const jsonCommand = `npx wrangler d1 execute ${config.database} ${config.flags} --json --command="${escapedSql}"`;

			const output = execSync(jsonCommand, {
				encoding: 'utf-8',
				maxBuffer: 50 * 1024 * 1024,
			});

			// Parse and format the output
			try {
				const parsed = JSON.parse(output);
				const results = parsed[0]?.results || parsed;

				// Save to file (resolve from repo root, not cli dir)
				const outputPath = resolve(repoRoot, outputFile);
				writeFileSync(outputPath, JSON.stringify(results, null, 2));
				console.log(`📄 Results saved to: ${outputPath}`);

				// Also print a summary to terminal
				if (Array.isArray(results)) {
					console.log(`   ${results.length} row(s) returned`);
					if (results.length > 0 && results.length <= 20) {
						console.log('');
						console.table(results);
					}
				}
			} catch {
				// If parsing fails, save raw output
				const outputPath = resolve(repoRoot, outputFile);
				writeFileSync(outputPath, output);
				console.log(`📄 Raw output saved to: ${outputPath}`);
			}
		} else {
			// Use execSync for simplicity - wrangler output goes directly to terminal
			// Strip CLOUDFLARE_API_TOKEN so wrangler uses the OAuth session instead
			// (the .env API token lacks D1 import permissions)
			const { CLOUDFLARE_API_TOKEN: _, ...cleanEnv } = process.env;
			execSync(command, {
				stdio: 'inherit',
				encoding: 'utf-8',
				env: {
					...cleanEnv,
					WRANGLER_SEND_METRICS: 'false',
				},
			});
		}

		console.log('');
		console.log(`✅ SQL executed successfully on ${env}`);
	} catch (error: unknown) {
		const execError = error as {
			status?: number;
			message?: string;
			stderr?: string;
			stdout?: string;
		};
		console.error('');
		console.error(`❌ Execution failed`);
		if (execError.stderr) console.error(execError.stderr);
		if (execError.stdout) console.error(execError.stdout);
		if (execError.message) console.error(execError.message);
		process.exit(execError.status ?? 1);
	} finally {
		// Restore original cwd
		process.chdir(originalCwd);
	}
}

main().catch((e) => {
	console.error('Fatal error:', e);
	process.exit(1);
});
