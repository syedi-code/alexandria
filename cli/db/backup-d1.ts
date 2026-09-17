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
import { exec } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const ENV_CONFIG = {
	staging: {
		database: 'antisocial-media-staging',
	},
	production: {
		database: 'antisocial-media',
	},
} as const;

type Environment = keyof typeof ENV_CONFIG;

const BACKUP_DIR = resolve(process.cwd(), '..', 'sql', 'backups');

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

	if (!(env in ENV_CONFIG)) {
		console.error(
			`Error: Invalid environment "${env}". Must be: staging, production\n`
		);
		printUsage();
		return null;
	}

	return { env: env as Environment };
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
	const config = ENV_CONFIG[env];
	const timestamp = getTimestamp();
	const filename = `backup-${env}-${timestamp}.sql`;

	ensureBackupDir();

	const outputPath = resolve(BACKUP_DIR, filename);

	console.log(`\n🗄️  D1 Backup Tool`);
	console.log(`─────────────────────────────────────────`);
	console.log(`   Environment: ${env}`);
	console.log(`   Database:    ${config.database}`);
	console.log(`   Output:      ${outputPath}`);
	console.log(`─────────────────────────────────────────\n`);

	const command = `npx wrangler d1 export ${config.database} --remote --output="${outputPath}"`;

	console.log(`⏳ Exporting database...`);

	try {
		const { stdout, stderr } = await execAsync(command, {
			cwd: resolve(process.cwd(), '..', 'apps', 'worker'),
			maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large exports
			env: {
				...process.env,
				CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
			},
		});

		if (stdout) console.log(stdout);
		if (stderr && !stderr.includes('Wrangler')) console.error(stderr);

		console.log(`\n✅ Backup complete: ${filename}`);
	} catch (error) {
		console.error(`\n❌ Backup failed:`);
		if (error instanceof Error) {
			console.error(error.message);
		}
		process.exit(1);
	}
}

main();
