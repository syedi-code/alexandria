#!/usr/bin/env tsx
/**
 * Verify that every work id cited inside essay prose still resolves.
 *
 * Essays embed works as [[book:UUID]] and [[book_cover:UUID]] tokens in their
 * body text, not only as foreign keys, so a migration that remapped an id
 * would silently break an essay written years ago with nothing failing at
 * write time. This is the check for that. It is exhaustive by construction —
 * it reads every essay and every work, never a sample.
 *
 * Run it before and after any migration that touches works.
 *
 * Usage:
 *   npx tsx cli/db/verify-work-tokens.ts --env <local|staging|production>
 *   npx tsx cli/db/verify-work-tokens.ts --env production --json
 */

import 'dotenv/config';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

// wrangler resolves database names and --env from the worker's wrangler.toml.
const WORKER_DIR = path.resolve(import.meta.dirname, '../../apps/worker');

const execAsync = promisify(exec);

const ENV_CONFIG = {
	local: { database: 'antisocial-media', flags: '--local' },
	staging: {
		database: 'antisocial-media-staging',
		flags: '--env staging --remote',
	},
	production: { database: 'antisocial-media', flags: '--remote' },
} as const;

type Environment = keyof typeof ENV_CONFIG;

const TOKEN_RE = /\[\[(book|book_cover):([0-9a-fA-F-]{36})/g;

interface D1QueryResult<T> {
	success: boolean;
	results: T[];
}

async function query<T>(env: Environment, sql: string): Promise<T[]> {
	const { database, flags } = ENV_CONFIG[env];
	const escaped = sql.replace(/\s+/g, ' ').trim().replace(/"/g, '\\"');
	const { stdout } = await execAsync(
		`npx wrangler d1 execute ${database} ${flags} --json --command="${escaped}"`,
		{ maxBuffer: 64 * 1024 * 1024, cwd: WORKER_DIR }
	);
	const parsed = JSON.parse(stdout) as D1QueryResult<T>[];
	return parsed.flatMap((r) => r.results ?? []);
}

interface Citation {
	essayId: string;
	tokenType: string;
	workId: string;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const envIndex = args.indexOf('--env');
	const env = (envIndex >= 0 ? args[envIndex + 1] : '') as Environment;
	const asJson = args.includes('--json');

	if (!ENV_CONFIG[env]) {
		console.error(
			'Usage: npx tsx cli/db/verify-work-tokens.ts --env <local|staging|production> [--json]'
		);
		process.exit(2);
	}

	const essays = await query<{ id: string; content: string }>(
		env,
		'SELECT id, content FROM essays'
	);
	// Before 0026_works.sql the table is still `books`; the check has to run on
	// both sides of that migration to be worth anything.
	const tables = await query<{ name: string }>(
		env,
		"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('works', 'books')"
	);
	const workTable = tables.some((t) => t.name === 'works')
		? 'works'
		: 'books';
	const works = await query<{ id: string }>(
		env,
		`SELECT id FROM ${workTable}`
	);
	const known = new Set(works.map((w) => w.id));

	const citations: Citation[] = [];
	for (const essay of essays) {
		for (const match of essay.content.matchAll(TOKEN_RE)) {
			citations.push({
				essayId: essay.id,
				tokenType: match[1],
				workId: match[2],
			});
		}
	}

	const broken = citations.filter((c) => !known.has(c.workId));
	const report = {
		environment: env,
		essays: essays.length,
		workTable,
		works: known.size,
		citations: citations.length,
		distinctWorksCited: new Set(citations.map((c) => c.workId)).size,
		broken,
	};

	if (asJson) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`environment        ${report.environment}`);
		console.log(`essays             ${report.essays}`);
		console.log(
			`works (${report.workTable})`.padEnd(19) + `${report.works}`
		);
		console.log(`citations in prose ${report.citations}`);
		console.log(`distinct works     ${report.distinctWorksCited}`);
		console.log(
			broken.length === 0
				? '\nEvery cited work resolves.'
				: `\n${broken.length} citation(s) resolve to nothing:`
		);
		for (const c of broken) {
			console.log(`  essay ${c.essayId}  [[${c.tokenType}:${c.workId}]]`);
		}
	}

	process.exit(broken.length === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
