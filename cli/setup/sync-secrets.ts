import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootEnvPath = path.resolve(__dirname, '../../.env');

// Load env vars into process.env
dotenv.config({ path: rootEnvPath });

const BLACKLIST = [
	// AI API keys - not needed in worker
	'GEMINI_API_KEY',
	'OPENAI_API_KEY',
	'ANTHROPIC_API_KEY',
	// Legacy Neon connection strings - D1 uses bindings instead
	'NEON_DATABASE_URL',
	'NEON_CONNECTION_STRING_ADMIN_ROLE',
	'NEON_CONNECTION_STRING_WORKER_ROLE',
	'NEON_CONNECTION_STRING_SCRIPTS_ROLE',
	// Cloudflare identifiers - not secrets
	'CLOUDFLARE_ACCOUNT_ID',
];

const args = process.argv.slice(2);
const isQuiet = args.includes('--quiet');

async function uploadSecret(key: string, value: string) {
	return new Promise<void>((resolve, reject) => {
		if (!isQuiet) console.log(`Uploading ${key}...`);
		// We run wrangler from the worker directory so it finds wrangler.toml
		const workerDir = path.resolve(__dirname, '../../apps/worker');

		const child = spawn('npx', ['wrangler', 'secret', 'put', key], {
			cwd: workerDir,
			stdio: [
				'pipe',
				isQuiet ? 'ignore' : 'inherit',
				isQuiet ? 'ignore' : 'inherit',
			],
			shell: true,
		});

		child.on('error', (err) => reject(err));
		child.on('exit', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Exit code ${code}`));
		});

		child.stdin.write(value);
		child.stdin.end();
	});
}

async function main() {
	if (!isQuiet) console.log('Syncing secrets from .env to Cloudflare...');

	let count = 0;

	// Parse the .env file directly to iterate over keys defined there
	const envConfig = dotenv.parse(fs.readFileSync(rootEnvPath));

	for (const key in envConfig) {
		if (BLACKLIST.includes(key)) {
			if (!isQuiet) console.log(`Skipping ${key} (blacklisted)`);
			continue;
		}

		const val = envConfig[key];
		if (!val) continue;

		try {
			await uploadSecret(key, val);
			count++;
		} catch (error) {
			console.error(`Failed to upload ${key}:`, error);
		}
	}

	if (isQuiet) {
		console.log(`Synced ${count} secrets.`);
	} else {
		console.log('Done.');
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
