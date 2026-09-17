import 'dotenv/config';
import inquirer from 'inquirer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * D1 Setup Script for Antisocial Media
 *
 * This script replaces the Neon-based setup with Cloudflare D1.
 * It guides users through:
 *   1. Wrangler authentication
 *   2. D1 database creation
 *   3. Schema application
 *   4. Environment configuration
 */

async function main() {
	console.log('🤖 Antisocial Media - D1 Setup');
	console.log('================================\n');

	// 1. Check Prerequisites
	await checkPrerequisites();

	// 2. Check Wrangler Auth
	await checkWranglerAuth();

	// 3. D1 Database Setup
	const dbId = await setupD1Database();

	// 4. Apply Schema
	await applyD1Schema(dbId);

	// 5. Env Config
	await configureEnvironment();

	// 6. Sync Secrets & Channels
	await syncCloudflare();

	console.log('\n✅ Setup Complete!');
	console.log('\nNext steps:');
	console.log('  1. Run "npm run dev:all" to start local development');
	console.log('  2. Run "npm run deploy:all" to deploy to Cloudflare');
}

async function checkPrerequisites() {
	console.log('Checking prerequisites...');
	try {
		await execAsync('node -v');
		await execAsync('npm -v');
		await execAsync('git --version');
		console.log('  ✓ Node, NPM, Git found\n');
	} catch (e) {
		console.error('Missing prerequisites (Node, NPM, or Git).', e);
		process.exit(1);
	}
}

async function checkWranglerAuth() {
	console.log('Checking Wrangler authentication...');
	try {
		const { stdout } = await execAsync('npx wrangler whoami');
		if (stdout.includes('You are not authenticated')) {
			console.log('  ⚠ Not logged in to Cloudflare');
			console.log('  Running: npx wrangler login\n');
			await execAsync('npx wrangler login');
		} else {
			// Extract account info from output
			const match = stdout.match(/Account Name: (.+)/);
			const account = match ? match[1].trim() : 'authenticated';
			console.log(`  ✓ Logged in as: ${account}\n`);
		}
	} catch (e) {
		console.error('Wrangler auth check failed:', e);
		console.log('Attempting login...');
		await execAsync('npx wrangler login');
	}
}

async function setupD1Database(): Promise<string> {
	console.log('Setting up D1 database...');

	// Check if database already exists
	try {
		const { stdout } = await execAsync('npx wrangler d1 list --json');
		const databases = JSON.parse(stdout);
		const existing = databases.find(
			(db: { name: string }) => db.name === 'antisocial-media'
		);

		if (existing) {
			console.log(`  ✓ Database "antisocial-media" already exists`);
			console.log(`  Database ID: ${existing.uuid}\n`);
			return existing.uuid;
		}
	} catch {
		// List failed, might be first time setup
	}

	// Create new database
	console.log('  Creating D1 database "antisocial-media"...');
	try {
		const { stdout } = await execAsync(
			'npx wrangler d1 create antisocial-media'
		);
		const match = stdout.match(/database_id\s*=\s*"([^"]+)"/);
		if (!match) {
			console.error('Could not parse database ID from output:', stdout);
			process.exit(1);
		}
		const dbId = match[1];
		console.log(`  ✓ Created database with ID: ${dbId}`);

		// Update wrangler.toml with the database ID
		await updateWranglerToml(dbId);

		return dbId;
	} catch (e) {
		console.error('Failed to create D1 database:', e);
		process.exit(1);
	}
}

async function updateWranglerToml(dbId: string) {
	const wranglerPath = path.resolve(
		process.cwd(),
		'apps/worker/wrangler.toml'
	);
	try {
		let content = await fs.readFile(wranglerPath, 'utf-8');
		content = content.replace(
			/database_id\s*=\s*"[^"]*"/,
			`database_id = "${dbId}"`
		);
		await fs.writeFile(wranglerPath, content);
		console.log('  ✓ Updated apps/worker/wrangler.toml with database ID\n');
	} catch (e) {
		console.warn(
			'  ⚠ Could not update wrangler.toml automatically. Please add:',
			e
		);
		console.log(`  database_id = "${dbId}"\n`);
	}
}

async function applyD1Schema(_dbId: string) {
	console.log('Applying D1 schema...');
	const migrationPath = path.resolve(
		process.cwd(),
		'sql/migrations/0001_init.sql'
	);

	try {
		await fs.access(migrationPath);
	} catch {
		console.error(`Migration file not found: ${migrationPath}`);
		process.exit(1);
	}

	try {
		await execAsync(
			`npx wrangler d1 execute antisocial-media --remote --file="${migrationPath}"`
		);
		console.log('  ✓ Schema applied successfully\n');
	} catch (e) {
		console.error('Schema application failed:', e);
		// Don't exit - schema might already exist
		console.log('  ⚠ Schema may already exist, continuing...\n');
	}
}

async function configureEnvironment() {
	console.log('Configuring environment...');
	const envPath = path.resolve(process.cwd(), '.env');
	let envContent = '';

	try {
		envContent = await fs.readFile(envPath, 'utf-8');
		console.log('  Found existing .env file');
	} catch {
		console.log('  Creating new .env file');
	}

	const questions = [
		{
			type: 'input',
			name: 'API_KEY',
			message: 'API Key (for web dashboard auth):',
			default: () => crypto.randomUUID(),
			when: !envContent.includes('API_KEY='),
		},
	];

	const answers = await inquirer.prompt(questions);

	let appendStr = '';
	for (const [key, value] of Object.entries(answers)) {
		if (value) appendStr += `${key}=${value}\n`;
	}

	if (appendStr) {
		await fs.appendFile(envPath, (envContent ? '\n' : '') + appendStr);
		console.log('  ✓ Updated .env\n');
	} else {
		console.log('  ✓ Environment already configured\n');
	}
}

async function syncCloudflare() {
	console.log('Syncing with Cloudflare...');

	console.log('  Syncing secrets...');
	try {
		await execAsync('npm run sync:secrets -- --quiet');
		console.log('  ✓ Secrets synced');
	} catch (e) {
		console.warn('  ⚠ Sync secrets failed:', e);
	}
}

main().catch(console.error);
