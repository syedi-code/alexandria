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
import { isEnvironment, query, type Environment } from '../wrangler.js';

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	let env: Environment | null = null;
	let email: string | null = null;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--env' && args[i + 1]) {
			const envArg = args[++i];
			if (isEnvironment(envArg) && envArg !== 'local') {
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

	console.log(`\n🔍 Querying users table on ${env}...\n`);

	try {
		const results = await query<{ id: string; email: string }>(env, 'db', {
			sql: `SELECT id, email, first_seen, last_seen FROM users
			       ${email ? 'WHERE email = ?' : ''}
			       ORDER BY first_seen ASC`,
			params: email ? [email] : [],
		});

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
	} catch (error) {
		console.error('❌ Failed to query database');
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

main();
