#!/usr/bin/env tsx
/**
 * Apply Schema to D1 Database
 *
 * Runs all SQL files from cli/setup/schema/ against a specified D1 database.
 * Supports both local development and remote databases.
 *
 * Usage:
 *   npx tsx cli/setup/apply-schema.ts [options]
 *
 * Options:
 *   --db <name>         Database name (default: antisocial-media)
 *   --env <env>         Environment suffix (e.g., staging → antisocial-media-staging)
 *   --local             Apply to local development database
 *   --file <file>       Apply only a specific schema file
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
	db: string;
	env?: string;
	local: boolean;
	file?: string;
	json: boolean;
}

interface SchemaResult {
	file: string;
	success: boolean;
	error?: string;
}

function parseArgs(): Options {
	const args = process.argv.slice(2);
	const options: Options = {
		db: 'antisocial-media',
		local: false,
		json: false,
	};

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--db':
				options.db = args[++i];
				break;
			case '--env':
				options.env = args[++i];
				break;
			case '--local':
				options.local = true;
				break;
			case '--file':
				options.file = args[++i];
				break;
			case '--json':
				options.json = true;
				break;
		}
	}

	// Apply environment suffix to database name
	if (options.env) {
		options.db = `${options.db}-${options.env}`;
	}

	return options;
}

function log(message: string, options: Options) {
	if (!options.json) {
		console.log(message);
	}
}

async function getSchemaFiles(specificFile?: string): Promise<string[]> {
	const schemaDir = path.resolve(__dirname, 'schema');

	let files: string[];
	try {
		files = await fs.readdir(schemaDir);
	} catch {
		throw new Error(`Schema directory not found: ${schemaDir}`);
	}

	let sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

	if (specificFile) {
		const match = sqlFiles.find(
			(f) => f === specificFile || f.includes(specificFile)
		);
		if (!match) {
			throw new Error(`Schema file not found: ${specificFile}`);
		}
		sqlFiles = [match];
	}

	return sqlFiles.map((f) => path.join(schemaDir, f));
}

async function applySchemaFile(
	filePath: string,
	dbName: string,
	local: boolean,
	options: Options
): Promise<SchemaResult> {
	const fileName = path.basename(filePath);
	log(`  Applying ${fileName}...`, options);

	const remoteFlag = local ? '--local' : '--remote';

	try {
		await execAsync(
			`npx wrangler d1 execute ${dbName} ${remoteFlag} --file="${filePath}"`,
			{ cwd: path.resolve(__dirname, '../../apps/worker') }
		);
		log(`    ✓ ${fileName} applied`, options);
		return { file: fileName, success: true };
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		// Check if it's just a "table already exists" type error
		if (
			error.includes('already exists') ||
			error.includes('SQLITE_ERROR')
		) {
			log(`    ⚠ ${fileName} may already be applied`, options);
			return {
				file: fileName,
				success: true,
				error: 'May already exist',
			};
		}
		log(`    ✗ ${fileName} failed: ${error}`, options);
		return { file: fileName, success: false, error };
	}
}

async function main() {
	const options = parseArgs();
	const target = options.local ? 'local' : 'remote';

	log(`Applying schema to ${options.db} (${target})...`, options);

	const schemaFiles = await getSchemaFiles(options.file);

	if (schemaFiles.length === 0) {
		log('No schema files found', options);
		process.exit(0);
	}

	log(`Found ${schemaFiles.length} schema file(s)`, options);

	const results: SchemaResult[] = [];

	for (const file of schemaFiles) {
		const result = await applySchemaFile(
			file,
			options.db,
			options.local,
			options
		);
		results.push(result);
	}

	const successful = results.filter((r) => r.success).length;
	const failed = results.filter((r) => !r.success).length;

	if (options.json) {
		console.log(
			JSON.stringify({
				database: options.db,
				target,
				results,
				summary: { total: results.length, successful, failed },
			})
		);
	} else {
		console.log(`\n✅ Schema application complete`);
		console.log(`   Database: ${options.db} (${target})`);
		console.log(`   Applied: ${successful}/${results.length} files`);
		if (failed > 0) {
			console.log(`   Failed: ${failed} files`);
			process.exit(1);
		}
	}
}

main().catch((e) => {
	console.error('Error:', e.message || e);
	process.exit(1);
});
