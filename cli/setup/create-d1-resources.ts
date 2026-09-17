#!/usr/bin/env tsx
/**
 * Create D1 Database Resources
 *
 * Creates a Cloudflare D1 database with the specified name and optionally
 * applies the schema. Outputs the database ID for use in wrangler.toml.
 *
 * Usage:
 *   npx tsx cli/setup/create-d1-resources.ts [options]
 *
 * Options:
 *   --name <name>       Database name (default: antisocial-media)
 *   --env <env>         Environment suffix (e.g., staging → antisocial-media-staging)
 *   --apply-schema      Apply schema files after creation
 *   --update-toml       Update wrangler.toml with the new database ID
 *   --json              Output result as JSON
 */

import 'dotenv/config';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Options {
	name: string;
	env?: string;
	applySchema: boolean;
	updateToml: boolean;
	json: boolean;
}

interface D1Database {
	uuid: string;
	name: string;
	created_at: string;
}

function parseArgs(): Options {
	const args = process.argv.slice(2);
	const options: Options = {
		name: 'antisocial-media',
		applySchema: false,
		updateToml: false,
		json: false,
	};

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--name':
				options.name = args[++i];
				break;
			case '--env':
				options.env = args[++i];
				break;
			case '--apply-schema':
				options.applySchema = true;
				break;
			case '--update-toml':
				options.updateToml = true;
				break;
			case '--json':
				options.json = true;
				break;
		}
	}

	// Apply environment suffix to name
	if (options.env) {
		options.name = `${options.name}-${options.env}`;
	}

	return options;
}

function log(message: string, options: Options) {
	if (!options.json) {
		console.log(message);
	}
}

async function checkWranglerAuth(): Promise<boolean> {
	try {
		const { stdout } = await execAsync('npx wrangler whoami');
		return !stdout.includes('You are not authenticated');
	} catch {
		return false;
	}
}

async function listD1Databases(): Promise<D1Database[]> {
	try {
		const { stdout } = await execAsync('npx wrangler d1 list --json');
		return JSON.parse(stdout);
	} catch {
		return [];
	}
}

async function createD1Database(
	name: string,
	options: Options
): Promise<string> {
	log(`Creating D1 database "${name}"...`, options);

	const { stdout } = await execAsync(`npx wrangler d1 create ${name}`);

	// Parse database ID from output (supports both TOML and JSON formats)
	// TOML: database_id = "xxx"
	// JSON: "database_id": "xxx"
	const match =
		stdout.match(/database_id\s*=\s*"([^"]+)"/) ||
		stdout.match(/"database_id":\s*"([^"]+)"/);
	if (!match) {
		throw new Error(`Could not parse database ID from output: ${stdout}`);
	}

	return match[1];
}

async function updateWranglerToml(
	dbId: string,
	dbName: string,
	env: string | undefined,
	options: Options
) {
	const wranglerPath = path.resolve(
		__dirname,
		'../../apps/worker/wrangler.toml'
	);

	try {
		let content = await fs.readFile(wranglerPath, 'utf-8');

		if (env) {
			// Check if env section exists
			const envSection = `[env.${env}]`;
			if (!content.includes(envSection)) {
				// Add new environment section at the end
				content += `\n${envSection}\nname = "journal-bot-${env}"\n\n[[env.${env}.d1_databases]]\nbinding = "DB"\ndatabase_name = "${dbName}"\ndatabase_id = "${dbId}"\n`;
			} else {
				// Update existing env section's database_id
				const envDbIdRegex = new RegExp(
					`(\\[env\\.${env}\\][\\s\\S]*?database_id\\s*=\\s*)"[^"]*"`,
					'm'
				);
				content = content.replace(envDbIdRegex, `$1"${dbId}"`);
			}
		} else {
			// Update main database_id
			content = content.replace(
				/database_id\s*=\s*"[^"]*"/,
				`database_id = "${dbId}"`
			);
		}

		await fs.writeFile(wranglerPath, content);
		log(`  ✓ Updated apps/worker/wrangler.toml`, options);
	} catch (e) {
		log(`  ⚠ Could not update wrangler.toml: ${e}`, options);
		throw e;
	}
}

async function applySchema(dbName: string, options: Options) {
	const schemaDir = path.resolve(__dirname, 'schema');

	let files: string[];
	try {
		files = await fs.readdir(schemaDir);
	} catch {
		throw new Error(`Schema directory not found: ${schemaDir}`);
	}

	const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

	if (sqlFiles.length === 0) {
		log('  No schema files found', options);
		return;
	}

	log(`Applying ${sqlFiles.length} schema file(s)...`, options);

	for (const file of sqlFiles) {
		const filePath = path.join(schemaDir, file);
		log(`  Applying ${file}...`, options);

		try {
			await execAsync(
				`npx wrangler d1 execute ${dbName} --remote --file="${filePath}"`
			);
			log(`    ✓ ${file} applied`, options);
		} catch (e) {
			// Schema might already exist
			log(`    ⚠ ${file} may already exist: ${e}`, options);
		}
	}
}

async function main() {
	const options = parseArgs();

	// Check auth
	const isAuthenticated = await checkWranglerAuth();
	if (!isAuthenticated) {
		console.error(
			'Not authenticated with Wrangler. Run: npx wrangler login'
		);
		process.exit(1);
	}

	// Check if database already exists
	const databases = await listD1Databases();
	const existing = databases.find((db) => db.name === options.name);

	let dbId: string;

	if (existing) {
		log(
			`Database "${options.name}" already exists (ID: ${existing.uuid})`,
			options
		);
		dbId = existing.uuid;
	} else {
		dbId = await createD1Database(options.name, options);
		log(`  ✓ Created database with ID: ${dbId}`, options);
	}

	// Update wrangler.toml if requested
	if (options.updateToml) {
		await updateWranglerToml(dbId, options.name, options.env, options);
	}

	// Apply schema if requested
	if (options.applySchema) {
		await applySchema(options.name, options);
	}

	// Output result
	if (options.json) {
		console.log(
			JSON.stringify({
				name: options.name,
				id: dbId,
				created: !existing,
			})
		);
	} else {
		console.log('\n✅ D1 database ready');
		console.log(`   Name: ${options.name}`);
		console.log(`   ID:   ${dbId}`);
		if (!options.updateToml) {
			console.log(`\nAdd to wrangler.toml:`);
			console.log(`   database_id = "${dbId}"`);
		}
	}
}

main().catch((e) => {
	console.error('Error:', e.message || e);
	process.exit(1);
});
