#!/usr/bin/env tsx
/**
 * Get Admin User ID (CF Access `sub` UUID)
 *
 * Queries the D1 `users` table for the row matching ADMIN_EMAIL and prints
 * the CF Access `sub` UUID. This UUID is needed for the backfill migration
 * (0013-backfill-user-id.sql) and differs per CF Access application
 * (staging vs production).
 *
 * Usage:
 *   npx tsx cli/db/get-admin-id.ts --env staging
 *   npx tsx cli/db/get-admin-id.ts --env production
 *   npx tsx cli/db/get-admin-id.ts --env staging --email you@example.com
 */

import 'dotenv/config';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const ENV_CONFIG = {
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

function main(): void {
	const args = process.argv.slice(2);

	let env: Environment | null = null;
	let email: string | null = null;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--env' && args[i + 1]) {
			const envArg = args[++i];
			if (envArg === 'staging' || envArg === 'production') {
				env = envArg;
			} else {
				console.error(`❌ Invalid environment: ${envArg}`);
				console.error('   Valid options: staging, production');
				process.exit(1);
			}
		} else if (args[i] === '--email' && args[i + 1]) {
			email = args[++i];
		} else if (args[i] === '--help' || args[i] === '-h') {
			console.log(`
Usage: npx tsx cli/db/get-admin-id.ts --env <staging|production> [--email <email>]

Options:
  --env <env>      Environment: staging or production (required)
  --email <email>  Email to look up (defaults to all users)

Examples:
  npx tsx cli/db/get-admin-id.ts --env staging
  npx tsx cli/db/get-admin-id.ts --env production --email admin@example.com
`);
			process.exit(0);
		}
	}

	if (!env) {
		console.error('❌ Missing required --env argument');
		console.error(
			'   Usage: npx tsx cli/db/get-admin-id.ts --env <staging|production>'
		);
		process.exit(1);
	}

	const config = ENV_CONFIG[env];

	// Build the SQL query
	const sql = email
		? `SELECT id, email, first_seen, last_seen FROM users WHERE email = '${email.replace(/'/g, "''")}'`
		: `SELECT id, email, first_seen, last_seen FROM users ORDER BY first_seen ASC`;

	// Run from apps/worker for wrangler.toml resolution
	const scriptDir = new URL('.', import.meta.url).pathname.replace(
		/^\/([A-Z]:)/,
		'$1'
	);
	const workerDir = resolve(scriptDir, '..', '..', 'apps', 'worker');

	const command = `npx wrangler d1 execute ${config.database} ${config.flags} --json --command="${sql}"`;

	console.log(`\n🔍 Querying users table on ${env}...\n`);

	try {
		const { CLOUDFLARE_API_TOKEN: _, ...cleanEnv } = process.env;
		const output = execSync(command, {
			encoding: 'utf-8',
			cwd: workerDir,
			env: { ...cleanEnv, WRANGLER_SEND_METRICS: 'false' },
			maxBuffer: 10 * 1024 * 1024,
		});

		const parsed = JSON.parse(output);
		const results = parsed[0]?.results || [];

		if (results.length === 0) {
			console.log('⚠️  No users found in the database.');
			console.log('');
			console.log('   To create your user record:');
			console.log('   1. Visit your staging/production URL in a browser');
			console.log('   2. Log in via Cloudflare Access');
			console.log(
				'   3. This creates your user record with your CF Access sub UUID'
			);
			console.log('   4. Run this script again');
			process.exit(1);
		}

		console.log(`Found ${results.length} user(s):\n`);
		console.table(results);

		// Print the first user's ID in a copy-pasteable format
		console.log('\n─────────────────────────────────────────────');
		for (const user of results) {
			console.log(`ADMIN_USER_ID=${user.id}  # ${user.email} (${env})`);
		}
		console.log('─────────────────────────────────────────────');
		console.log(
			'\n💡 Use this UUID in sql/migrations/0013-backfill-user-id.sql'
		);
		if (env === 'staging') {
			console.log(
				'⚠️  Note: Your production UUID will be DIFFERENT — run this again with --env production after deploying there.'
			);
		}
	} catch (error: unknown) {
		const execError = error as {
			stderr?: string;
			stdout?: string;
			message?: string;
		};
		console.error('❌ Failed to query database');
		if (execError.stderr) console.error(execError.stderr);
		if (execError.message) console.error(execError.message);
		process.exit(1);
	}
}

main();
