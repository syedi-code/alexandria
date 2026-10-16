import dotenv from 'dotenv';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SqlStatement } from '@alexandria/core/platform';
import { renderSqlFile, renderStatement } from './sql-file.js';

const run = promisify(execFile);

/** wrangler resolves database names, buckets and --env from the worker's wrangler.toml. */
const WORKER_DIR = path.resolve(import.meta.dirname, '../apps/worker');

/**
 * Wrangler's entry script, run with node directly rather than through npx: no
 * shell is involved, so SQL passed with --command reaches wrangler verbatim on
 * every platform.
 */
const WRANGLER = createRequire(path.join(WORKER_DIR, 'package.json')).resolve(
	'wrangler/bin/wrangler.js'
);

export const ENVIRONMENTS = {
	local: {
		flags: ['--local'],
		db: 'antisocial-media',
		search: 'alexandria-search',
		bucket: 'antisocial-media-files',
	},
	staging: {
		flags: ['--env', 'staging', '--remote'],
		db: 'antisocial-media-staging',
		search: 'alexandria-search-staging',
		bucket: 'antisocial-media-files-staging',
	},
	production: {
		flags: ['--remote'],
		db: 'antisocial-media',
		search: 'alexandria-search',
		bucket: 'antisocial-media-files',
	},
} as const;

export type Environment = keyof typeof ENVIRONMENTS;
export type Database = 'db' | 'search';

export function isEnvironment(value: string | undefined): value is Environment {
	return value !== undefined && value in ENVIRONMENTS;
}

/**
 * A failed wrangler command rejects with the spawn error, and on Windows its
 * stderr is a libuv assertion. What actually went wrong — an expired token, a
 * renamed table — is the Cloudflare API error it printed to stdout as JSON.
 * Without this, that message is the one thing not shown.
 */
function apiError(stdout: string): string | null {
	try {
		const error = JSON.parse(stdout.slice(stdout.search(/^{/m))).error;
		const notes = (error.notes ?? [])
			.map((n: { text: string }) => n.text)
			.join('; ');
		return notes || error.text || null;
	} catch {
		return null;
	}
}

const DOT_ENV: Record<string, string> = (() => {
	try {
		return dotenv.parse(
			readFileSync(path.resolve(WORKER_DIR, '../../.env'))
		);
	} catch {
		return {};
	}
})();

/**
 * Which credential wrangler gets. Wrangler prefers CLOUDFLARE_API_TOKEN over
 * its login, and the scripts load `.env`, whose CLOUDFLARE_API_TOKEN is the
 * Access/Turnstile token — no D1 scope, and it expires. Passed through, every
 * query failed with 7403 while the login itself was fine. So `.env`'s copy is
 * never used here; CI's (set in the real environment) still is.
 */
const CREDENTIAL = (() => {
	const cli =
		process.env.ALEXANDRIA_CLI_TOKEN ?? DOT_ENV.ALEXANDRIA_CLI_TOKEN;
	if (cli) return { name: 'ALEXANDRIA_CLI_TOKEN', token: cli };
	const ambient = process.env.CLOUDFLARE_API_TOKEN;
	if (ambient && ambient !== DOT_ENV.CLOUDFLARE_API_TOKEN)
		return { name: 'CLOUDFLARE_API_TOKEN', token: ambient };
	return null;
})();

const ACCOUNT_ID =
	process.env.CLOUDFLARE_ACCOUNT_ID ?? DOT_ENV.CLOUDFLARE_ACCOUNT_ID;

const NEEDS = 'D1 Edit and Workers R2 Storage Edit, with no expiry';

function wranglerEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.CLOUDFLARE_API_TOKEN;
	if (CREDENTIAL) env.CLOUDFLARE_API_TOKEN = CREDENTIAL.token;
	if (ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;
	return env;
}

/**
 * A credential problem is one line and exit code 1, never a stack trace. The
 * exit waits a tick: process.exit() straight after fetch() trips a libuv
 * assertion on Windows. The promise never settles, so nothing runs meanwhile.
 */
function refuse(reason: string): Promise<never> {
	const fix = CREDENTIAL
		? `${CREDENTIAL.name} needs ${NEEDS} — dash.cloudflare.com/profile/api-tokens`
		: `set ALEXANDRIA_CLI_TOKEN in .env (${NEEDS}) — dash.cloudflare.com/profile/api-tokens`;
	console.error(`Cloudflare auth failed: ${reason}. Fix: ${fix}`);
	setTimeout(() => process.exit(1), 50);
	return new Promise(() => {});
}

let verified: Promise<void> | undefined;

/** Checks the token once per run, so an expired one says so before any query. */
function verifyToken(): Promise<void> {
	if (!CREDENTIAL) return Promise.resolve();
	verified ??= (async () => {
		const scopes = ['user', ACCOUNT_ID && `accounts/${ACCOUNT_ID}`];
		for (const scope of scopes.filter(Boolean)) {
			const response = await fetch(
				`https://api.cloudflare.com/client/v4/${scope}/tokens/verify`,
				{ headers: { Authorization: `Bearer ${CREDENTIAL.token}` } }
			).catch(() => null);
			if (!response) return; // offline: let wrangler say what is wrong
			const body = (await response.json().catch(() => ({}))) as {
				result?: { status?: string; expires_on?: string };
			};
			const { status, expires_on } = body.result ?? {};
			if (status === 'active') return;
			if (status === 'expired')
				return refuse(
					`${CREDENTIAL.name} expired on ${expires_on?.slice(0, 10)}`
				);
			if (status) return refuse(`${CREDENTIAL.name} is ${status}`);
		}
		return refuse(`${CREDENTIAL.name} is not a valid token`);
	})();
	return verified;
}

const AUTH_CODES = new Set([7403, 9106, 9109, 10000, 10001]);

async function wrangler(args: string[]): Promise<string> {
	const remote = args.includes('--remote');
	if (remote) await verifyToken();
	try {
		const { stdout } = await run(process.execPath, [WRANGLER, ...args], {
			cwd: WORKER_DIR,
			env: wranglerEnv(),
			maxBuffer: 512 * 1024 * 1024,
		});
		return stdout;
	} catch (error) {
		const stdout = (error as { stdout?: string }).stdout ?? '';
		const output = stdout + ((error as { stderr?: string }).stderr ?? '');
		const reported = apiError(stdout);
		if (
			remote &&
			(AUTH_CODES.has(apiCode(stdout)) ||
				/not logged in|authentication error/i.test(output))
		)
			return refuse(reported ?? 'wrangler is not logged in');
		if (!reported) throw error;
		throw new Error(`wrangler ${args[0]} ${args[1]}: ${reported}`, {
			cause: error,
		});
	}
}

function apiCode(stdout: string): number {
	try {
		return JSON.parse(stdout.slice(stdout.search(/^{/m))).error.code;
	} catch {
		return 0;
	}
}

interface D1Result {
	results?: Record<string, unknown>[];
	meta?: { rows_written?: number };
}

/** Wrangler prints progress before its JSON; the JSON is the array that starts a line. */
function parseResults(stdout: string): D1Result[] {
	const start = stdout.search(/^\[/m);
	if (start === -1) throw new Error(`Unexpected wrangler output:\n${stdout}`);
	return JSON.parse(stdout.slice(start));
}

const d1 = (env: Environment, database: Database, ...args: string[]) => {
	const { flags, ...names } = ENVIRONMENTS[env];
	return wrangler([
		'd1',
		'execute',
		names[database],
		...flags,
		'--json',
		...args,
	]);
};

export async function query<T>(
	env: Environment,
	database: Database,
	{ sql, params = [] }: { sql: string; params?: SqlStatement['params'] }
): Promise<T[]> {
	const stdout = await d1(
		env,
		database,
		'--command',
		renderStatement({ sql, params })
	);
	return parseResults(stdout).flatMap((r) => (r.results ?? []) as T[]);
}

/**
 * Runs a SQL file. Remote files go through D1's import API, which reports a
 * summary row ("Rows written") instead of per-statement results; local runs
 * report per-statement meta. Returns null when neither says.
 */
export async function executeSqlFile(
	env: Environment,
	database: Database,
	file: string
): Promise<number | null> {
	const results = parseResults(
		await d1(env, database, '--yes', '--file', file)
	);
	let written = 0;
	for (const result of results) {
		written += result.meta?.rows_written ?? 0;
		for (const row of result.results ?? []) {
			if (typeof row['Rows written'] === 'number')
				written += row['Rows written'];
		}
	}
	return written > 0 ? written : null;
}

async function inTempDir<T>(use: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), 'alexandria-'));
	try {
		return await use(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export const execute = (
	env: Environment,
	database: Database,
	statements: readonly SqlStatement[]
) =>
	inTempDir(async (dir) => {
		const file = path.join(dir, 'statements.sql');
		await writeFile(file, renderSqlFile(statements));
		return executeSqlFile(env, database, file);
	});

/**
 * Dumps a remote database to a SQL file. D1 refuses to export a database that
 * contains a virtual table, which is why the page index lives in SEARCH and is
 * rebuilt rather than backed up.
 */
export const exportDatabase = (
	env: Environment,
	database: Database,
	file: string
) =>
	wrangler([
		'd1',
		'export',
		ENVIRONMENTS[env][database],
		...ENVIRONMENTS[env].flags,
		'--output',
		file,
	]);

export const downloadObject = (env: Environment, key: string) =>
	inTempDir(async (dir) => {
		const { flags, bucket } = ENVIRONMENTS[env];
		const file = path.join(dir, 'object');
		await wrangler([
			'r2',
			'object',
			'get',
			`${bucket}/${key}`,
			...flags,
			'--file',
			file,
		]);
		return new Uint8Array(await readFile(file));
	});
