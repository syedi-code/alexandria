import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootEnvPath = path.resolve(__dirname, '../../.env');
const devVarsPath = path.resolve(__dirname, '../../apps/worker/.dev.vars');

// Keys to exclude from the worker's .dev.vars (frontend-only or sensitive AI keys)
const BLACKLIST = [
	'GEMINI_API_KEY',
	'OPENAI_API_KEY',
	'ANTHROPIC_API_KEY',
	'VITE_API_KEY',
	// Legacy Neon connection strings - D1 uses local binding in dev
	'NEON_DATABASE_URL',
	'NEON_CONNECTION_STRING_ADMIN_ROLE',
	'NEON_CONNECTION_STRING_WORKER_ROLE',
	'NEON_CONNECTION_STRING_SCRIPTS_ROLE',
	// Cloudflare identifiers - not needed as env vars
	'CLOUDFLARE_ACCOUNT_ID',
];

const args = process.argv.slice(2);
const isQuiet = args.includes('--quiet');

async function main() {
	if (!isQuiet)
		console.log('Syncing secrets from .env to apps/worker/.dev.vars...');

	// Parse the root .env file
	const envConfig = dotenv.parse(fs.readFileSync(rootEnvPath));

	const lines: string[] = [];
	let count = 0;

	for (const key in envConfig) {
		if (BLACKLIST.includes(key)) {
			if (!isQuiet) console.log(`Skipping ${key} (blacklisted)`);
			continue;
		}

		const val = envConfig[key];
		if (!val) continue;

		lines.push(`${key}=${val}`);
		count++;
	}

	// Always inject LOCAL_DEV flag for wrangler dev (never present in deployed secrets)
	lines.push('LOCAL_DEV=true');
	count++;

	fs.writeFileSync(devVarsPath, lines.join('\n') + '\n');

	if (isQuiet) {
		console.log(`Synced ${count} secrets to .dev.vars`);
	} else {
		console.log(`Wrote ${count} secrets to ${devVarsPath}`);
		console.log('Done.');
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
