import { execFile } from 'node:child_process';
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

async function wrangler(args: string[]): Promise<string> {
	try {
		const { stdout } = await run(process.execPath, [WRANGLER, ...args], {
			cwd: WORKER_DIR,
			maxBuffer: 512 * 1024 * 1024,
		});
		return stdout;
	} catch (error) {
		const stdout = (error as { stdout?: string }).stdout ?? '';
		const reported = apiError(stdout);
		if (!reported) throw error;
		throw new Error(`wrangler ${args[0]} ${args[1]}: ${reported}`, {
			cause: error,
		});
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
