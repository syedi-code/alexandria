#!/usr/bin/env tsx
/**
 * Refuse to deploy a worker that would trust LOCAL_DEV.
 *
 * LOCAL_DEV skips Cloudflare Access and hands the caller an admin context. It
 * has to: a local `wrangler dev` has no Access in front of it. Nothing in a
 * request can tell a local process from a deployed one — `wrangler dev`
 * populates `request.cf` with real geolocation and simulates the custom domain
 * from wrangler.toml — so the runtime cannot defend itself here.
 *
 * Deploy time can. If LOCAL_DEV is set on the target, or committed to
 * wrangler.toml, this fails before anything ships.
 *
 * Usage:
 *   npm run assert:deployable -- --env production
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WORKER_DIR = path.resolve(import.meta.dirname, '../../apps/worker');
const WRANGLER = createRequire(path.join(WORKER_DIR, 'package.json')).resolve(
	'wrangler/bin/wrangler.js'
);

/** Variables that must never exist on a deployed worker. */
const FORBIDDEN = ['LOCAL_DEV'];

const args = process.argv.slice(2);
const envIndex = args.indexOf('--env');
const target = envIndex === -1 ? 'production' : args[envIndex + 1];

if (target !== 'production' && target !== 'staging') {
	console.error(
		`Unknown environment "${target}" (expected staging or production)`
	);
	process.exit(1);
}

const failures: string[] = [];

// 1. wrangler.toml — a [vars] entry ships with the code, so catch it in source.
const toml = readFileSync(path.join(WORKER_DIR, 'wrangler.toml'), 'utf8');
for (const name of FORBIDDEN) {
	const declared = new RegExp(`^\\s*${name}\\s*=`, 'm').test(toml);
	if (declared)
		failures.push(`${name} is declared in apps/worker/wrangler.toml`);
}

// 2. The secrets actually set on the target worker.
try {
	const listed = execFileSync(
		process.execPath,
		[
			WRANGLER,
			'secret',
			'list',
			...(target === 'staging' ? ['--env', 'staging'] : []),
		],
		{ cwd: WORKER_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
	).toString();

	for (const name of FORBIDDEN) {
		if (new RegExp(`"name":\\s*"${name}"`).test(listed)) {
			failures.push(`${name} is set as a secret on the ${target} worker`);
		}
	}
} catch (error) {
	// Not fatal: a fork without credentials should still be able to run the
	// source check. Say so rather than passing silently.
	console.warn(
		`Could not list ${target} secrets, so only wrangler.toml was checked.`
	);
	if (process.env.CI) {
		console.error((error as Error).message);
		process.exit(1);
	}
}

if (failures.length) {
	console.error(`\nRefusing to deploy to ${target}:\n`);
	for (const failure of failures) console.error(`  • ${failure}`);
	console.error(
		'\nLOCAL_DEV bypasses Cloudflare Access and grants an admin context.\n' +
			'It belongs in apps/worker/.dev.vars and nowhere else.\n\n' +
			`  cd apps/worker && npx wrangler secret delete LOCAL_DEV${
				target === 'staging' ? ' --env staging' : ''
			}\n`
	);
	process.exit(1);
}

console.log(`${target}: no development bypass is set. Safe to deploy.`);
