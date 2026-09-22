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
	// An account API token, used by tooling on the developer's machine to set
	// up Access apps and Turnstile. The worker must never hold it: a worker
	// secret is readable by every route in the worker, and this one can
	// rewrite the Access policies in front of it.
	'CLOUDFLARE_API_TOKEN',
];

/**
 * Variables that name an environment's own resources, and so must never be
 * copied from a developer's `.env` onto production. `POLICY_AUD` held the
 * staging Access app's audience here while production's secret held the
 * production one; a sync would have pointed production at staging and made
 * every sign-in fail with `JWT_VERIFICATION_FAILED`.
 */
const PER_ENVIRONMENT = ['POLICY_AUD', 'TEAM_DOMAIN'];

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

		if (PER_ENVIRONMENT.includes(key)) {
			console.log(
				`Skipping ${key}: it names this environment's own Access app. ` +
					`Set it per environment with \`wrangler secret put ${key}\`.`
			);
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
