#!/usr/bin/env tsx
/**
 * Auth Debug Utility
 *
 * Tests the full auth chain from outside the Worker for a given environment.
 * Checks: token presence, token validity/expiry, JWKS endpoint reachability,
 * Worker health, and end-to-end /api/me auth.
 *
 * Usage:
 *   npx tsx cli/debug/verify-auth.ts                     # default: staging
 *   npx tsx cli/debug/verify-auth.ts --env local         # local Worker
 *   npx tsx cli/debug/verify-auth.ts --env staging       # staging Worker
 *   npx tsx cli/debug/verify-auth.ts --env production    # production Worker
 */

import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Load .env from repo root (not cwd, which may be cli/)
const repoRoot = resolve(import.meta.dirname, '..', '..');
config({ path: join(repoRoot, '.env') });

const ENV_CONFIG = {
	local: {
		workerUrl: 'http://127.0.0.1:8787',
		label: 'Local',
	},
	staging: {
		workerUrl: 'https://antisocial-worker-staging.iysyed01.workers.dev',
		label: 'Staging',
	},
	production: {
		workerUrl: 'https://alexandria.socialeating.studio',
		label: 'Production',
	},
} as const;

type Environment = keyof typeof ENV_CONFIG;

const PASS = '\x1b[32m[PASS]\x1b[0m';
const FAIL = '\x1b[31m[FAIL]\x1b[0m';
const SKIP = '\x1b[33m[SKIP]\x1b[0m';

let passCount = 0;
let failCount = 0;

function pass(msg: string): void {
	console.log(`${PASS} ${msg}`);
	passCount++;
}

function fail(msg: string, fix?: string): void {
	console.log(`${FAIL} ${msg}`);
	if (fix) console.log(`       → ${fix}`);
	failCount++;
}

function skip(msg: string, reason: string): void {
	console.log(`${SKIP} ${msg}`);
	console.log(`       (skipped: ${reason})`);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const payload = Buffer.from(parts[1]!, 'base64url').toString('utf-8');
		return JSON.parse(payload);
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	let env: Environment = 'staging';

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--env' && args[i + 1]) {
			const envArg = args[++i] as string;
			if (
				envArg === 'local' ||
				envArg === 'staging' ||
				envArg === 'production'
			) {
				env = envArg;
			} else {
				console.error(`❌ Invalid environment: ${envArg}`);
				console.error('   Valid options: local, staging, production');
				process.exit(1);
			}
		} else if (args[i] === '--help' || args[i] === '-h') {
			console.log(`
Usage: npx tsx cli/debug/verify-auth.ts [--env local|staging|production]

Options:
  --env <env>    Target environment (default: staging)

Examples:
  npx tsx cli/debug/verify-auth.ts
  npx tsx cli/debug/verify-auth.ts --env local
  npx tsx cli/debug/verify-auth.ts --env production
`);
			process.exit(0);
		}
	}

	const config = ENV_CONFIG[env];
	const teamDomain = process.env.TEAM_DOMAIN ?? '';
	const tokenPath = join(
		homedir(),
		'.cloudflared',
		'socialeating.cloudflareaccess.com-org-token'
	);

	console.log(`\nAuth Debug Report (${config.label})`);
	console.log('='.repeat(40));
	console.log('');

	// Check 1: Org token file exists (prerequisite for getting app tokens)
	let orgToken: string | null = null;
	try {
		orgToken = readFileSync(tokenPath, 'utf-8').trim();
		pass(`Org token file exists: ${tokenPath}`);
	} catch {
		fail(
			`Org token file missing: ${tokenPath}`,
			`Run: cloudflared access login ${config.workerUrl}`
		);
	}

	// Check 2: Org token not expired
	let tokenExpired = false;
	let tokenPayload: Record<string, unknown> | null = null;
	if (orgToken) {
		tokenPayload = decodeJwtPayload(orgToken);
		if (!tokenPayload) {
			fail(
				'Org token is malformed (cannot decode JWT payload)',
				'Re-authenticate via cloudflared'
			);
			tokenExpired = true;
		} else {
			const exp = tokenPayload['exp'] as number | undefined;
			if (exp && Date.now() / 1000 > exp) {
				const expDate = new Date(exp * 1000).toISOString();
				fail(
					`Org token expired at ${expDate}`,
					`Run: cloudflared access login ${config.workerUrl}`
				);
				tokenExpired = true;
			} else {
				const expDate = exp
					? new Date(exp * 1000).toISOString()
					: 'unknown';
				pass(`Org token not expired (expires: ${expDate})`);
			}
		}
	} else {
		skip('Token expiry check', 'org token file missing');
		tokenExpired = true;
	}

	// Check 2b: Get APP-level token (has correct audience for CF Access edge)
	let appToken: string | null = null;
	if (!tokenExpired) {
		try {
			appToken = execSync(
				`cloudflared access token --app=${config.workerUrl}`,
				{ encoding: 'utf-8', timeout: 8000 }
			).trim();
			if (appToken) {
				const appPayload = decodeJwtPayload(appToken);
				const aud = Array.isArray(appPayload?.['aud'])
					? (appPayload!['aud'] as string[])[0]
					: String(appPayload?.['aud'] ?? '');
				pass(`App token obtained (aud: ${aud?.slice(0, 12)}...)`);
			} else {
				fail(
					'cloudflared returned empty app token',
					'Re-authenticate: cloudflared access login ' +
						config.workerUrl
				);
			}
		} catch {
			fail(
				'Failed to get app-level token via cloudflared',
				`Run: cloudflared access login ${config.workerUrl}`
			);
		}
	} else {
		skip('App token check', 'org token expired or missing');
	}

	// Check 3: Token issuer matches TEAM_DOMAIN
	if (tokenPayload && !tokenExpired) {
		const iss = tokenPayload['iss'] as string | undefined;
		if (teamDomain && iss) {
			if (iss === teamDomain || iss?.includes('cloudflareaccess.com')) {
				pass(`Token issuer: ${iss}`);
			} else {
				fail(
					`Token issuer mismatch: got "${iss}", expected "${teamDomain}"`
				);
			}
		} else if (iss) {
			pass(`Token issuer: ${iss}`);
		} else {
			fail('Token missing issuer claim');
		}
	} else {
		skip(
			'Token issuer check',
			tokenExpired ? 'token expired or missing' : 'no token payload'
		);
	}

	// Check 4: JWKS endpoint reachable
	if (teamDomain) {
		const jwksUrl = `${teamDomain}/cdn-cgi/access/certs`;
		try {
			const response = await fetch(jwksUrl, {
				signal: AbortSignal.timeout(5000),
			});
			if (response.ok) {
				pass(`JWKS endpoint reachable: ${jwksUrl}`);
			} else {
				fail(
					`JWKS endpoint returned ${response.status}: ${jwksUrl}`,
					'Check TEAM_DOMAIN in .env'
				);
			}
		} catch (err) {
			fail(
				`JWKS endpoint unreachable: ${jwksUrl}`,
				`Error: ${String(err)}`
			);
		}
	} else {
		skip('JWKS endpoint check', 'TEAM_DOMAIN not set in .env');
	}

	// Check 5: Worker health check
	const healthUrl = `${config.workerUrl}/health`;
	try {
		const response = await fetch(healthUrl, {
			signal: AbortSignal.timeout(8000),
		});
		if (response.ok) {
			pass(`Worker health check: ${healthUrl} (${response.status})`);
		} else {
			fail(
				`Worker returned ${response.status}: ${healthUrl}`,
				env === 'local'
					? 'Ensure wrangler dev is running: npm run dev:worker'
					: 'Check deployment status'
			);
		}
	} catch (err) {
		fail(
			`Worker unreachable: ${healthUrl}`,
			env === 'local'
				? 'Start the worker: npm run dev:worker'
				: `Network error: ${String(err)}`
		);
	}

	// Check 6: End-to-end auth chain (/api/me)
	const authToken = appToken ?? orgToken;
	if (authToken && !tokenExpired) {
		const meUrl = `${config.workerUrl}/api/me`;
		try {
			const response = await fetch(meUrl, {
				headers: {
					'cf-access-jwt-assertion': authToken,
					'cookie': `CF_Authorization=${authToken}`,
				},
				redirect: 'manual',
				signal: AbortSignal.timeout(8000),
			});
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get('location') ?? 'unknown';
				fail(
					`Auth chain: GET /api/me → ${response.status} redirect to CF Access login`,
					`CF Access edge rejected the token. Audience mismatch? Location: ${location}`
				);
			} else {
				const body = (await response.json()) as Record<string, unknown>;
				if (response.ok && body['user']) {
					const userData = body['user'] as {
						email?: string;
						role?: string;
					};
					pass(
						`Auth chain: GET /api/me → ${response.status} (user: ${userData.email}, role: ${userData.role})`
					);
				} else {
					const code =
						(body as { code?: string })['code'] ?? 'UNKNOWN';
					const hint =
						(body as { hint?: string })['hint'] ?? 'No hint';
					fail(
						`Auth chain: GET /api/me → ${response.status} (code: ${code})`,
						hint
					);
				}
			}
		} catch (err) {
			fail(`Auth chain: GET /api/me failed`, `Error: ${String(err)}`);
		}
	} else {
		skip(
			'End-to-end auth chain test',
			tokenExpired ? 'fix the token issue above first' : 'token missing'
		);
	}

	// Summary
	const total = passCount + failCount;
	console.log('');
	console.log('─'.repeat(40));
	if (failCount === 0) {
		console.log(`\x1b[32mResult: All ${total} checks passed\x1b[0m`);
	} else {
		console.log(
			`\x1b[31mResult: ${failCount} of ${total} checks failed\x1b[0m`
		);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Unexpected error:', err);
	process.exit(1);
});
