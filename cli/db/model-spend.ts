#!/usr/bin/env tsx
/**
 * What the model roster has cost, per reader.
 *
 * Every assistant message already stores its own `usage` — this reads what is
 * there rather than adding any accounting. Nothing here enforces a limit; it
 * exists so that a limit can be chosen against real numbers instead of a guess.
 *
 * Usage:
 *   npx tsx cli/db/model-spend.ts [options]
 *
 * Options:
 *   --env <env>    Environment: local, staging, or production (default: local)
 *   --since <date> ISO date; only turns at or after it (default: all of time)
 *   --json         Output as JSON instead of a table
 *
 * Examples:
 *   npm run spend:prod
 *   npx tsx cli/db/model-spend.ts --env production --since 2026-09-01
 */

import 'dotenv/config';
import { isEnvironment, query, type Environment } from '../wrangler.js';

/**
 * Dollars per million tokens, as this deployment is actually billed.
 *
 * Left empty on purpose rather than filled with remembered numbers: provider
 * prices change, and a stale rate here would be a wrong answer that looks like
 * a right one. Tokens are always reported; a model with no entry reports no
 * cost, and the footer says how many did. Fill these in from the provider's
 * own pricing page.
 */
const PRICES: Record<string, { input: number; output: number }> = {
	// 'gpt-5.6-luna': { input: 0, output: 0 },
	// 'claude-haiku-4-5-20251001': { input: 0, output: 0 },
	// 'gemini-3.8-flash': { input: 0, output: 0 },
};

interface SpendRow {
	email: string;
	model_id: string | null;
	turns: number;
	input_tokens: number | null;
	output_tokens: number | null;
	first_turn: string | null;
	last_turn: string | null;
}

/**
 * `messages.usage` is the AI SDK's usage object stored verbatim as JSON, so the
 * token counts come out through json_extract rather than columns of their own.
 * A turn that failed before the model answered has no usage and is not counted.
 */
const SPEND_SQL = `
	SELECT u.email                                        AS email,
	       m.model_id                                     AS model_id,
	       COUNT(*)                                       AS turns,
	       SUM(json_extract(m.usage, '$.inputTokens'))    AS input_tokens,
	       SUM(json_extract(m.usage, '$.outputTokens'))   AS output_tokens,
	       MIN(m.created_at)                              AS first_turn,
	       MAX(m.created_at)                              AS last_turn
	  FROM messages m
	  JOIN conversations c ON c.id = m.conversation_id
	  JOIN users u ON u.id = c.user_id
	 WHERE m.usage IS NOT NULL
	   AND m.created_at >= ?
	 GROUP BY u.email, m.model_id
	 ORDER BY u.email ASC, turns DESC`;

const costOf = (row: SpendRow): number | null => {
	const price = row.model_id ? PRICES[row.model_id] : undefined;
	if (!price) return null;
	return (
		((row.input_tokens ?? 0) * price.input +
			(row.output_tokens ?? 0) * price.output) /
		1_000_000
	);
};

const int = (n: number | null) => (n ?? 0).toLocaleString('en-US');
const money = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`);

function table(rows: SpendRow[]): void {
	const cells = rows.map((row) => [
		row.email,
		row.model_id ?? '(unrecorded)',
		String(row.turns),
		int(row.input_tokens),
		int(row.output_tokens),
		int(Math.round((row.input_tokens ?? 0) / Math.max(row.turns, 1))),
		money(costOf(row)),
		(row.last_turn ?? '').slice(0, 10),
	]);
	const head = [
		'reader',
		'model',
		'turns',
		'input',
		'output',
		'in/turn',
		'cost',
		'last',
	];
	const width = head.map((h, i) =>
		Math.max(h.length, ...cells.map((c) => c[i].length))
	);
	const line = (c: string[]) =>
		c.map((v, i) => (i < 2 ? v.padEnd(width[i]) : v.padStart(width[i])));

	console.log(line(head).join('  '));
	console.log(width.map((w) => '─'.repeat(w)).join('  '));
	for (const c of cells) console.log(line(c).join('  '));
}

function summarise(rows: SpendRow[]): void {
	const turns = rows.reduce((n, r) => n + r.turns, 0);
	const input = rows.reduce((n, r) => n + (r.input_tokens ?? 0), 0);
	const output = rows.reduce((n, r) => n + (r.output_tokens ?? 0), 0);
	const priced = rows.filter((r) => costOf(r) !== null);
	const cost = priced.reduce((n, r) => n + (costOf(r) ?? 0), 0);

	console.log();
	console.log(
		`${turns} turns · ${int(input)} input · ${int(output)} output · ` +
			`${input && output ? Math.round(input / output) : 0}:1`
	);
	if (priced.length === rows.length && rows.length > 0) {
		console.log(`${money(cost)} total`);
	} else {
		const unpriced = new Set(
			rows.filter((r) => costOf(r) === null).map((r) => r.model_id)
		);
		console.log(
			`No cost for ${[...unpriced].join(', ')} — add a rate to PRICES in ${'cli/db/model-spend.ts'}.`
		);
	}
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

	const rows = await query<SpendRow>(env, 'db', {
		sql: SPEND_SQL,
		params: [since],
	});

	if (argv.includes('--json')) {
		console.log(
			JSON.stringify(
				rows.map((row) => ({ ...row, cost: costOf(row) })),
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
	table(rows);
	summarise(rows);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
