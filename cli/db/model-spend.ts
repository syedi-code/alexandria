#!/usr/bin/env tsx
/**
 * What the model roster has cost, per reader.
 *
 * Reads the `usage_events` ledger, so cache reads and writes are priced at
 * their own rates rather than as plain input. Rates come from `PRICES` in
 * `packages/core/platform/prices.ts`, the one table every cost figure reads.
 * Nothing here enforces a limit; it exists so that a limit can be chosen
 * against real numbers instead of a guess.
 *
 * Usage:
 *   npx tsx cli/db/model-spend.ts [options]
 *
 * Options:
 *   --env <env>    Environment: local, staging, or production (default: local)
 *   --since <date> ISO date; only turns at or after it (default: all of time)
 *   --breakdown    One row per model, reader and week
 *   --json         Output as JSON instead of a table
 *
 * Examples:
 *   npm run spend:prod
 *   npx tsx cli/db/model-spend.ts --env production --since 2026-09-01 --breakdown
 */

import 'dotenv/config';
import { isEnvironment, query, type Environment } from '../wrangler.js';
import { byModel, rowCost, totalOf, type SpendRow } from './spend-report.js';

/** Both kinds are spend; only `chat_turn` is counted against an allowance. */
const spendSql = (breakdown: boolean) => `
	SELECT u.email                       AS email,
	       e.model_id                    AS model_id,
	       ${breakdown ? 'e.billing_week AS billing_week,' : ''}
	       COUNT(*)                      AS turns,
	       SUM(e.input_tokens)           AS input_tokens,
	       SUM(e.cache_read_tokens)      AS cache_read_tokens,
	       SUM(e.cache_write_tokens)     AS cache_write_tokens,
	       SUM(e.output_tokens)          AS output_tokens,
	       MAX(e.created_at)             AS last_turn
	  FROM usage_events e
	  JOIN users u ON u.id = e.user_id
	 WHERE e.created_at >= ?
	 GROUP BY ${breakdown ? 'e.model_id, u.email, e.billing_week' : 'u.email, e.model_id'}
	 ORDER BY ${breakdown ? 'e.model_id ASC, u.email ASC, e.billing_week ASC' : 'u.email ASC, turns DESC'}`;

const int = (n: number | null) => (n ?? 0).toLocaleString('en-US');
const money = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`);
const share = (n: number | null) =>
	n === null ? '—' : `${Math.round(n * 100)}%`;

function print(head: string[], cells: string[][], left: number): void {
	const width = head.map((h, i) =>
		Math.max(h.length, ...cells.map((c) => c[i].length))
	);
	const line = (c: string[]) =>
		c.map((v, i) => (i < left ? v.padEnd(width[i]) : v.padStart(width[i])));
	console.log(line(head).join('  '));
	console.log(width.map((w) => '─'.repeat(w)).join('  '));
	for (const c of cells) console.log(line(c).join('  '));
}

function readers(rows: SpendRow[], breakdown: boolean): void {
	const head = breakdown ? ['model', 'reader', 'week'] : ['reader', 'model'];
	print(
		[
			...head,
			'turns',
			'input',
			'cache-r',
			'cache-w',
			'output',
			'cost',
			'last',
		],
		rows.map((row) => [
			...(breakdown
				? [
						row.model_id ?? '(unrecorded)',
						row.email,
						row.billing_week ?? '',
					]
				: [row.email, row.model_id ?? '(unrecorded)']),
			String(row.turns),
			int(row.input_tokens),
			int(row.cache_read_tokens),
			int(row.cache_write_tokens),
			int(row.output_tokens),
			money(rowCost(row)),
			(row.last_turn ?? '').slice(0, 10),
		]),
		head.length
	);
}

function models(rows: SpendRow[]): void {
	print(
		['model', 'turns', 'input', 'in/turn', 'cached', 'output', 'cost'],
		byModel(rows).map((m) => [
			m.model_id ?? '(unrecorded)',
			String(m.turns),
			int(m.input),
			int(Math.round(m.input / Math.max(m.turns, 1))),
			share(m.cacheShare),
			int(m.output),
			money(m.cost),
		]),
		1
	);
}

function summarise(rows: SpendRow[]): void {
	const turns = rows.reduce((n, r) => n + r.turns, 0);
	const { cost, unpriced } = totalOf(rows);
	console.log();
	console.log(`${turns} turns · ${money(cost)} priced`);
	if (unpriced.length > 0)
		console.log(
			`No rate for ${unpriced.map((m) => m ?? '(unrecorded)').join(', ')} — ` +
				`its turns are not in the total. Add it to PRICES in packages/core/platform/prices.ts.`
		);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const flag = (name: string) => {
		const at = argv.indexOf(name);
		return at === -1 ? undefined : argv[at + 1];
	};

	const envArg = flag('--env') ?? 'local';
	if (!isEnvironment(envArg)) {
		console.error(`Unknown environment: ${envArg}`);
		process.exit(1);
	}
	const env: Environment = envArg;
	const since = flag('--since') ?? '';
	const breakdown = argv.includes('--breakdown');

	const rows = await query<SpendRow>(env, 'db', {
		sql: spendSql(breakdown),
		params: [since],
	});

	if (argv.includes('--json')) {
		console.log(
			JSON.stringify(
				{
					rows: rows.map((row) => ({ ...row, cost: rowCost(row) })),
					models: byModel(rows),
				},
				null,
				2
			)
		);
		return;
	}

	if (rows.length === 0) {
		console.log(
			`No answered turns in ${env}${since ? ` since ${since}` : ''}.`
		);
		return;
	}

	console.log(`Model spend — ${env}${since ? `, since ${since}` : ''}`);
	console.log();
	readers(rows, breakdown);
	console.log();
	models(rows);
	summarise(rows);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
