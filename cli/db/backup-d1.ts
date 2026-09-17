#!/usr/bin/env tsx
/**
 * D1 Database Backup Tool
 *
 * Downloads a local SQL backup of D1 databases (staging or production).
 *
 * Usage:
 *   npx tsx cli/db/backup-d1.ts --env <env>
 *
 * Options:
 *   --env <env>    Environment: staging or production (required)
 *
 * Examples:
 *   npm run backup              # Backs up production (from root)
 *   npm run backup:staging      # Backs up staging
 *   npm run backup:prod         # Backs up production
 */

import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	ENVIRONMENTS,
	exportDatabase,
	isEnvironment,
	type Environment,
} from '../wrangler.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const BACKUP_DIR = resolve(import.meta.dirname, '..', '..', 'sql', 'backups');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function printUsage(): void {
	console.log(`
Usage: npx tsx cli/db/backup-d1.ts --env <env>

Options:
  --env <env>    Environment: staging or production (required)

Examples:
  npm run backup              # Backs up production (from root)
  npm run backup:staging      # Backs up staging
  npm run backup:prod         # Backs up production
`);
}

function parseArgs(): { env: Environment } | null {
	const args = process.argv.slice(2);
	let env: string | undefined;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--env' && args[i + 1]) {
			env = args[i + 1];
			i++;
		}
	}

	if (!env) {
		console.error('Error: --env is required\n');
		printUsage();
		return null;
	}

	if (!isEnvironment(env) || env === 'local') {
		console.error(
			`Error: Invalid environment "${env}". Must be: staging, production\n`
		);
		printUsage();
		return null;
	}

	return { env };
}

function getTimestamp(): string {
	const now = new Date();
	return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function ensureBackupDir(): void {
	if (!existsSync(BACKUP_DIR)) {
		mkdirSync(BACKUP_DIR, { recursive: true });
		console.log(`📁 Created backup directory: ${BACKUP_DIR}`);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const parsed = parseArgs();
	if (!parsed) {
		process.exit(1);
	}

	const { env } = parsed;
	const timestamp = getTimestamp();
	const filename = `backup-${env}-${timestamp}.sql`;

	ensureBackupDir();

	const outputPath = resolve(BACKUP_DIR, filename);

	console.log(`\n🗄️  D1 Backup Tool`);
	console.log(`─────────────────────────────────────────`);
	console.log(`   Environment: ${env}`);
	console.log(`   Database:    ${ENVIRONMENTS[env].db}`);
	console.log(`   Output:      ${outputPath}`);
	console.log(`─────────────────────────────────────────\n`);

	console.log(`Exporting database...`);

	try {
		await exportDatabase(env, 'db', outputPath);
		console.log(`
Backup complete: ${filename}`);
	} catch (error) {
		console.error(`
Backup failed:`);
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

main();
