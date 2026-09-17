#!/usr/bin/env tsx
/**
 * Purge Superseded Quote Versions
 *
 * Quote edits used to copy-on-write: the new text became a NEW row whose
 * `replaces` pointed at the old one. Today's editor mutates quotes in place,
 * so those old rows are pure bloat — but essays, threads, and connections may
 * still point at superseded ids. This script:
 *
 *   1. Builds every replaces-chain and maps each superseded id → the chain
 *      head (the latest version).
 *   2. Re-points at the head:
 *      - `[[quote:UUID]]` tokens inside essays.content
 *      - essay_references rows (entity_type='quote')
 *      - thread_items rows   (entity_type='quote')
 *      - connections rows    (a/b side with type 'quote')
 *      Tables with a unique index use UPDATE OR IGNORE + DELETE of leftovers
 *      (when the head is already referenced alongside the old version).
 *   3. Deletes the superseded quote rows and clears the now-dangling
 *      `replaces` on the surviving heads.
 *
 * Usage:
 *   npx tsx cli/db/cleanup-quote-versions.ts --env <env> [options]
 *
 * Options:
 *   --env <env>    Environment: local, staging, or production (required)
 *   --dry-run      Print SQL without executing
 *   --yes, -y      Skip confirmation prompt
 */

import 'dotenv/config';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import {
	executeSqlFile,
	isEnvironment,
	query,
	type Environment,
} from '../wrangler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

interface Options {
	env: Environment;
	dryRun: boolean;
	yes: boolean;
}

function parseArgs(): Options {
	const args = process.argv.slice(2);
	const options: Options = { env: 'local', dryRun: false, yes: false };

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--env': {
				const env = args[++i];
				if (!isEnvironment(env)) {
					console.error(`Invalid environment: ${env}`);
					process.exit(1);
				}
				options.env = env;
				break;
			}
			case '--dry-run':
				options.dryRun = true;
				break;
			case '--yes':
			case '-y':
				options.yes = true;
				break;
			case '--help':
			case '-h':
				console.log(`
Purge Superseded Quote Versions

Usage:
  npx tsx cli/db/cleanup-quote-versions.ts --env <env> [options]

Options:
  --env <env>    Environment: local, staging, or production (required)
  --dry-run      Print SQL without executing
  --yes, -y      Skip confirmation prompt
`);
				process.exit(0);
		}
	}

	return options;
}

async function confirm(message: string): Promise<boolean> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolvePromise) => {
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolvePromise(answer.toLowerCase() === 'y');
		});
	});
}

/** Escape a string for a SQL single-quoted literal */
function sqlEscape(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chain resolution
// ─────────────────────────────────────────────────────────────────────────────

interface QuoteRow {
	id: string;
	replaces: string | null;
}

/**
 * Map every superseded quote id → the head (latest) of its replaces-chain.
 * Heads are rows that no other row replaces.
 */
function buildSupersededMap(rows: QuoteRow[]): Map<string, string> {
	const replacesOf = new Map<string, string>(); // id → id it replaces
	const replacedIds = new Set<string>(); // ids some row replaces
	const ids = new Set(rows.map((r) => r.id));

	for (const r of rows) {
		if (r.replaces) {
			replacesOf.set(r.id, r.replaces);
			replacedIds.add(r.replaces);
		}
	}

	const map = new Map<string, string>();
	for (const r of rows) {
		if (replacedIds.has(r.id)) continue; // not a head
		// Walk down the chain from this head, mapping every ancestor to it.
		let cursor = replacesOf.get(r.id);
		const seen = new Set<string>([r.id]);
		while (cursor && !seen.has(cursor)) {
			seen.add(cursor);
			// Ancestor may already be deleted / never migrated; only map rows
			// that actually exist so we don't emit no-op SQL.
			if (ids.has(cursor)) map.set(cursor, r.id);
			cursor = replacesOf.get(cursor);
		}
	}
	return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL generation
// ─────────────────────────────────────────────────────────────────────────────

function generateSql(map: Map<string, string>): string {
	const statements: string[] = [];

	for (const [oldId, headId] of map) {
		const oldLit = sqlEscape(oldId);
		const headLit = sqlEscape(headId);
		const oldToken = sqlEscape(`[[quote:${oldId}]]`);
		const headToken = sqlEscape(`[[quote:${headId}]]`);

		statements.push(
			`-- ${oldId} → ${headId}`,
			// Essay body tokens
			`UPDATE essays SET content = REPLACE(content, ${oldToken}, ${headToken}) WHERE content LIKE '%' || ${oldToken} || '%';`,
			// essay_references — unique (essay_id, entity_type, entity_id)
			`UPDATE OR IGNORE essay_references SET entity_id = ${headLit} WHERE entity_type = 'quote' AND entity_id = ${oldLit};`,
			`DELETE FROM essay_references WHERE entity_type = 'quote' AND entity_id = ${oldLit};`,
			// thread_items — unique (thread_id, entity_type, entity_id)
			`UPDATE OR IGNORE thread_items SET entity_id = ${headLit} WHERE entity_type = 'quote' AND entity_id = ${oldLit};`,
			`DELETE FROM thread_items WHERE entity_type = 'quote' AND entity_id = ${oldLit};`,
			// connections — unique (a_type, a_id, b_type, b_id)
			`UPDATE OR IGNORE connections SET a_id = ${headLit} WHERE a_type = 'quote' AND a_id = ${oldLit};`,
			`DELETE FROM connections WHERE a_type = 'quote' AND a_id = ${oldLit};`,
			`UPDATE OR IGNORE connections SET b_id = ${headLit} WHERE b_type = 'quote' AND b_id = ${oldLit};`,
			`DELETE FROM connections WHERE b_type = 'quote' AND b_id = ${oldLit};`
		);
	}

	const idList = [...map.keys()].map(sqlEscape).join(', ');
	statements.push(
		`-- Purge superseded rows and clear dangling replaces pointers`,
		`DELETE FROM quotes WHERE id IN (${idList});`,
		`UPDATE quotes SET replaces = NULL WHERE replaces IS NOT NULL;`
	);

	return statements.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const { env, dryRun, yes } = parseArgs();

	console.log(`\nEnvironment: ${env}`);

	console.log('Fetching quote replaces-chains…');
	const rows = await query<QuoteRow>(env, 'db', {
		sql: `SELECT id, replaces FROM quotes`,
	});
	console.log(`  ${rows.length} quotes total`);

	const map = buildSupersededMap(rows);
	if (map.size === 0) {
		console.log('  No superseded quote versions found. Nothing to do.');
		return;
	}
	console.log(`  ${map.size} superseded version(s) to purge\n`);

	const sql = generateSql(map);

	if (dryRun) {
		console.log('── DRY RUN — generated SQL ──\n');
		console.log(sql);
		return;
	}

	if (!yes) {
		const ok = await confirm(
			`Re-point references and DELETE ${map.size} superseded quote row(s) from ${env}?`
		);
		if (!ok) {
			console.log('Aborted.');
			return;
		}
	}

	const outDir = resolve(repoRoot, 'sql', 'maintenance', 'generated');
	if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const sqlFile = resolve(outDir, `cleanup-quote-versions-${stamp}.sql`);
	writeFileSync(sqlFile, sql, 'utf8');
	console.log(`SQL written to ${sqlFile}`);

	console.log('Executing…');
	await executeSqlFile(env, 'db', sqlFile);
	console.log(`Done. Purged ${map.size} superseded quote version(s).`);
}

main().catch((err) => {
	console.error('Failed:', err instanceof Error ? err.message : err);
	process.exit(1);
});
