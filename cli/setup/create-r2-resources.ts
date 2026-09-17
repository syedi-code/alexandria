#!/usr/bin/env tsx
/**
 * Create R2 Bucket Resources
 *
 * Creates a Cloudflare R2 bucket with the specified name.
 * Outputs the bucket name for use in wrangler.toml.
 *
 * Usage:
 *   npx tsx cli/setup/create-r2-resources.ts [options]
 *
 * Options:
 *   --name <name>       Bucket name (default: antisocial-media-files)
 *   --env <env>         Environment suffix (e.g., staging → antisocial-media-files-staging)
 *   --update-toml       Update wrangler.toml with the new bucket binding
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
	updateToml: boolean;
	json: boolean;
}

interface R2Bucket {
	name: string;
	creation_date: string;
}

function parseArgs(): Options {
	const args = process.argv.slice(2);
	const options: Options = {
		name: 'antisocial-media-files',
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

async function listR2Buckets(): Promise<R2Bucket[]> {
	try {
		const { stdout } = await execAsync('npx wrangler r2 bucket list');
		// Parse the table output (not JSON unfortunately)
		const lines = stdout.trim().split('\n').slice(1); // Skip header
		return lines
			.filter((line) => line.trim())
			.map((line) => {
				const [name, creation_date] = line.split(/\s{2,}/);
				return {
					name: name?.trim(),
					creation_date: creation_date?.trim(),
				};
			})
			.filter((b) => b.name);
	} catch {
		return [];
	}
}

async function createR2Bucket(name: string, options: Options): Promise<void> {
	log(`Creating R2 bucket "${name}"...`, options);
	await execAsync(`npx wrangler r2 bucket create ${name}`);
}

async function updateWranglerToml(
	bucketName: string,
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
				content += `\n${envSection}\nname = "journal-bot-${env}"\n\n[[env.${env}.r2_buckets]]\nbinding = "R2_BUCKET"\nbucket_name = "${bucketName}"\n`;
			} else {
				// Check if r2_buckets section exists for this env
				const envR2Regex = new RegExp(
					`\\[\\[env\\.${env}\\.r2_buckets\\]\\]`,
					'm'
				);
				if (content.match(envR2Regex)) {
					// Update existing bucket_name
					const envBucketRegex = new RegExp(
						`(\\[\\[env\\.${env}\\.r2_buckets\\]\\][\\s\\S]*?bucket_name\\s*=\\s*)"[^"]*"`,
						'm'
					);
					content = content.replace(
						envBucketRegex,
						`$1"${bucketName}"`
					);
				} else {
					// Add r2_buckets to existing env section
					const envSectionIndex = content.indexOf(envSection);
					const nextSectionMatch = content
						.slice(envSectionIndex + envSection.length)
						.match(/\n\[(?!env\.)/);
					const insertIndex = nextSectionMatch
						? envSectionIndex +
							envSection.length +
							(nextSectionMatch.index ?? 0)
						: content.length;

					const r2Config = `\n[[env.${env}.r2_buckets]]\nbinding = "R2_BUCKET"\nbucket_name = "${bucketName}"\n`;
					content =
						content.slice(0, insertIndex) +
						r2Config +
						content.slice(insertIndex);
				}
			}
		} else {
			// Update main bucket_name
			content = content.replace(
				/bucket_name\s*=\s*"[^"]*"/,
				`bucket_name = "${bucketName}"`
			);
		}

		await fs.writeFile(wranglerPath, content);
		log(`  ✓ Updated apps/worker/wrangler.toml`, options);
	} catch (e) {
		log(`  ⚠ Could not update wrangler.toml: ${e}`, options);
		throw e;
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

	// Check if bucket already exists
	const buckets = await listR2Buckets();
	const existing = buckets.find((b) => b.name === options.name);

	let created = false;

	if (existing) {
		log(`Bucket "${options.name}" already exists`, options);
	} else {
		await createR2Bucket(options.name, options);
		log(`  ✓ Created bucket: ${options.name}`, options);
		created = true;
	}

	// Update wrangler.toml if requested
	if (options.updateToml) {
		await updateWranglerToml(options.name, options.env, options);
	}

	// Output result
	if (options.json) {
		console.log(
			JSON.stringify({
				name: options.name,
				created,
			})
		);
	} else {
		console.log('\n✅ R2 bucket ready');
		console.log(`   Name: ${options.name}`);
		if (!options.updateToml) {
			console.log(`\nAdd to wrangler.toml:`);
			console.log(`   bucket_name = "${options.name}"`);
		}
	}
}

main().catch((e) => {
	console.error('Error:', e.message || e);
	process.exit(1);
});
