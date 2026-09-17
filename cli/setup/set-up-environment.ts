#!/usr/bin/env tsx
/**
 * Set Up Environment
 *
 * Interactive CLI to set up a complete Cloudflare environment (D1, R2, secrets).
 * Can be used for production, staging, or any custom environment.
 *
 * Usage:
 *   npx tsx cli/setup/set-up-environment.ts [options]
 *
 * Options:
 *   --env <env>         Environment name (e.g., staging, production)
 *   --skip-d1           Skip D1 database creation
 *   --skip-r2           Skip R2 bucket creation
 *   --skip-schema       Skip schema application
 *   --skip-secrets      Skip secrets sync
 *   --non-interactive   Run without prompts (use defaults)
 */

import 'dotenv/config';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import inquirer from 'inquirer';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface SetupOptions {
	env?: string;
	skipD1: boolean;
	skipR2: boolean;
	skipSchema: boolean;
	skipSecrets: boolean;
	nonInteractive: boolean;
}

interface SetupResult {
	d1?: { name: string; id: string; created: boolean };
	r2?: { name: string; created: boolean };
	schema?: { applied: number; failed: number };
	secrets?: { synced: number };
}

function parseArgs(): SetupOptions {
	const args = process.argv.slice(2);
	const options: SetupOptions = {
		skipD1: false,
		skipR2: false,
		skipSchema: false,
		skipSecrets: false,
		nonInteractive: false,
	};

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--env':
				options.env = args[++i];
				break;
			case '--skip-d1':
				options.skipD1 = true;
				break;
			case '--skip-r2':
				options.skipR2 = true;
				break;
			case '--skip-schema':
				options.skipSchema = true;
				break;
			case '--skip-secrets':
				options.skipSecrets = true;
				break;
			case '--non-interactive':
				options.nonInteractive = true;
				break;
		}
	}

	return options;
}

async function checkWranglerAuth(): Promise<boolean> {
	try {
		const { stdout } = await execAsync('npx wrangler whoami');
		return !stdout.includes('You are not authenticated');
	} catch {
		return false;
	}
}

async function promptForEnvironment(
	options: SetupOptions
): Promise<SetupOptions> {
	if (options.nonInteractive) {
		return options;
	}

	const answers = await inquirer.prompt([
		{
			type: 'list',
			name: 'env',
			message: 'Which environment do you want to set up?',
			choices: [
				{ name: 'Production (default resources)', value: undefined },
				{ name: 'Staging', value: 'staging' },
				{ name: 'Custom...', value: '__custom__' },
			],
			when: !options.env,
		},
		{
			type: 'input',
			name: 'customEnv',
			message: 'Enter custom environment name:',
			when: (answers) => answers.env === '__custom__',
			validate: (input) =>
				/^[a-z0-9-]+$/.test(input) ||
				'Environment name must be lowercase alphanumeric with hyphens',
		},
		{
			type: 'confirm',
			name: 'createD1',
			message: 'Create D1 database?',
			default: true,
			when: !options.skipD1,
		},
		{
			type: 'confirm',
			name: 'createR2',
			message: 'Create R2 bucket?',
			default: true,
			when: !options.skipR2,
		},
		{
			type: 'confirm',
			name: 'applySchema',
			message: 'Apply database schema?',
			default: true,
			when: (answers) =>
				answers.createD1 !== false && !options.skipSchema,
		},
		{
			type: 'confirm',
			name: 'syncSecrets',
			message: 'Sync secrets from .env?',
			default: true,
			when: !options.skipSecrets,
		},
	]);

	return {
		...options,
		env: answers.customEnv || answers.env || options.env,
		skipD1: answers.createD1 === false,
		skipR2: answers.createR2 === false,
		skipSchema: answers.applySchema === false,
		skipSecrets: answers.syncSecrets === false,
	};
}

async function runScript(
	scriptPath: string,
	args: string[] = []
): Promise<string> {
	const fullPath = path.resolve(__dirname, scriptPath);
	const command = `npx tsx "${fullPath}" ${args.join(' ')}`;
	const { stdout, stderr } = await execAsync(command, {
		cwd: path.resolve(__dirname, '../..'),
	});
	if (stderr && !stderr.includes('ExperimentalWarning')) {
		console.warn(stderr);
	}
	return stdout;
}

async function createD1(env?: string): Promise<SetupResult['d1']> {
	console.log('\n📦 Setting up D1 database...');

	const args = ['--update-toml', '--json'];
	if (env) args.push('--env', env);

	try {
		const output = await runScript('create-d1-resources.ts', args);
		const result = JSON.parse(output.trim());
		console.log(
			`   ✓ Database "${result.name}" ${result.created ? 'created' : 'already exists'}`
		);
		console.log(`   ID: ${result.id}`);
		return result;
	} catch (e) {
		console.error('   ✗ Failed to create D1 database:', e);
		throw e;
	}
}

async function createR2(env?: string): Promise<SetupResult['r2']> {
	console.log('\n🪣 Setting up R2 bucket...');

	const args = ['--update-toml', '--json'];
	if (env) args.push('--env', env);

	try {
		const output = await runScript('create-r2-resources.ts', args);
		const result = JSON.parse(output.trim());
		console.log(
			`   ✓ Bucket "${result.name}" ${result.created ? 'created' : 'already exists'}`
		);
		return result;
	} catch (e) {
		console.error('   ✗ Failed to create R2 bucket:', e);
		throw e;
	}
}

async function applySchema(env?: string): Promise<SetupResult['schema']> {
	console.log('\n📝 Applying database schema...');

	const args = ['--json'];
	if (env) args.push('--env', env);

	try {
		const output = await runScript('apply-schema.ts', args);
		const result = JSON.parse(output.trim());
		console.log(
			`   ✓ Applied ${result.summary.successful}/${result.summary.total} schema files`
		);
		if (result.summary.failed > 0) {
			console.log(
				`   ⚠ ${result.summary.failed} files had issues (may already exist)`
			);
		}
		return {
			applied: result.summary.successful,
			failed: result.summary.failed,
		};
	} catch (e) {
		console.error('   ✗ Failed to apply schema:', e);
		throw e;
	}
}

async function syncSecrets(env?: string): Promise<SetupResult['secrets']> {
	console.log('\n🔐 Syncing secrets...');

	const workerDir = path.resolve(__dirname, '../../apps/worker');
	const envFlag = env ? `--env ${env}` : '';

	try {
		// Use the existing sync-secrets script with modifications for env
		const secretsScript = path.resolve(
			__dirname,
			'./sync-secrets.ts'
		);
		const { stdout } = await execAsync(
			`npx tsx "${secretsScript}" --quiet ${envFlag}`.trim(),
			{ cwd: workerDir }
		);

		const match = stdout.match(/Synced (\d+) secrets/);
		const count = match ? parseInt(match[1], 10) : 0;
		console.log(`   ✓ Synced ${count} secrets`);
		return { synced: count };
	} catch (e) {
		console.error('   ✗ Failed to sync secrets:', e);
		throw e;
	}
}

async function main() {
	console.log('🚀 Antisocial Media - Environment Setup');
	console.log('========================================');

	// Parse CLI args
	let options = parseArgs();

	// Check Wrangler auth
	console.log('\nChecking Wrangler authentication...');
	const isAuthenticated = await checkWranglerAuth();
	if (!isAuthenticated) {
		console.log('Not authenticated. Running: npx wrangler login');
		await execAsync('npx wrangler login');
	} else {
		console.log('   ✓ Authenticated with Cloudflare');
	}

	// Interactive prompts
	options = await promptForEnvironment(options);

	const envLabel = options.env ? ` (${options.env})` : ' (production)';
	console.log(`\nSetting up environment${envLabel}...`);

	const result: SetupResult = {};

	// D1 Database
	if (!options.skipD1) {
		result.d1 = await createD1(options.env);
	}

	// R2 Bucket
	if (!options.skipR2) {
		result.r2 = await createR2(options.env);
	}

	// Schema
	if (!options.skipSchema && !options.skipD1) {
		result.schema = await applySchema(options.env);
	}

	// Secrets
	if (!options.skipSecrets) {
		try {
			result.secrets = await syncSecrets(options.env);
		} catch {
			console.log('   ⚠ Secrets sync skipped (may need manual setup)');
		}
	}

	// Summary
	console.log('\n========================================');
	console.log('✅ Environment setup complete!');
	console.log(`   Environment: ${options.env || 'production'}`);

	if (result.d1) {
		console.log(`   D1 Database: ${result.d1.name} (${result.d1.id})`);
	}
	if (result.r2) {
		console.log(`   R2 Bucket: ${result.r2.name}`);
	}
	if (result.schema) {
		console.log(`   Schema: ${result.schema.applied} files applied`);
	}
	if (result.secrets) {
		console.log(`   Secrets: ${result.secrets.synced} synced`);
	}

	console.log('\nNext steps:');
	if (options.env === 'staging') {
		console.log('  1. Create orphan staging branch:');
		console.log('     git checkout --orphan staging');
		console.log('     git commit --allow-empty -m "init staging"');
		console.log('     git push -u origin staging');
		console.log('  2. Set GitHub secrets for CI/CD');
		console.log('  3. Push to staging branch to trigger deployment');
	} else {
		console.log('  1. Run "npm run dev" to start local development');
		console.log('  2. Run "npm run deploy:all" to deploy to production');
	}
}

main().catch((e) => {
	console.error('\n❌ Setup failed:', e.message || e);
	process.exit(1);
});
