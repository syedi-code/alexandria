import { parseArgs } from 'node:util';
import type { SqlStatement } from '@alexandria/core/platform';
import {
	execute,
	isEnvironment,
	type Database,
	type Environment,
} from './wrangler.js';

/** D1 Free allows 100,000 rows written per day, shared with everything else the app writes. */
export const DEFAULT_REMOTE_BUDGET = 60_000;

export interface RunOptions {
	env: Environment;
	budget: number;
	documents: string[];
	force: boolean;
	dryRun: boolean;
}

export function parseRunOptions(command: string): RunOptions {
	const { values } = parseArgs({
		options: {
			'env': { type: 'string' },
			'budget': { type: 'string' },
			'document': { type: 'string', multiple: true },
			'force': { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false },
		},
	});

	if (!isEnvironment(values.env)) {
		console.error(
			`Usage: npm run ${command} -- --env <local|staging|production> [--budget ROWS] [--document ID]... [--force] [--dry-run]`
		);
		process.exit(1);
	}

	const budget = values.budget
		? Number(values.budget)
		: values.env === 'local'
			? Infinity
			: DEFAULT_REMOTE_BUDGET;
	if (!(budget > 0)) {
		console.error('--budget must be a positive number of rows');
		process.exit(1);
	}

	return {
		env: values.env,
		budget,
		documents: values.document ?? [],
		force: values.force,
		dryRun: values['dry-run'],
	};
}

/**
 * Rows are estimated before each document is written, so a run stops before a
 * document that would cross the budget rather than halfway through it.
 */
export class RowBudget {
	private spent = 0;

	constructor(private readonly limit: number) {}

	allows(estimate: number): boolean {
		return this.spent + estimate <= this.limit;
	}

	spend(rows: number): void {
		this.spent += rows;
	}

	describe(): string {
		return Number.isFinite(this.limit)
			? `${this.spent.toLocaleString()} of ${this.limit.toLocaleString()} rows`
			: `${this.spent.toLocaleString()} rows`;
	}
}

export interface PreparedWrite {
	database: Database;
	statements: SqlStatement[];
	/** Rows expected to be written; checked against the budget before writing. */
	estimate: number;
	/** Shown on the item's line, e.g. "412 pages". */
	summary: string;
}

/**
 * Prepares and writes one item at a time until the queue or the budget runs
 * out. A failure is reported and skipped; the next run picks it up again.
 */
export async function runBudgeted<Item>(
	queue: readonly Item[],
	options: RunOptions,
	step: {
		label(item: Item): string;
		prepare(item: Item): Promise<PreparedWrite>;
	}
): Promise<void> {
	const budget = new RowBudget(options.budget);
	let done = 0;

	for (const item of queue) {
		const label = step.label(item);
		try {
			const write = await step.prepare(item);
			if (!budget.allows(write.estimate)) {
				console.log(
					`\nStopping before ${label}: it needs ~${write.estimate} rows and ${budget.describe()} are spent. Run again to continue.`
				);
				break;
			}
			const written = options.dryRun
				? write.estimate
				: ((await execute(
						options.env,
						write.database,
						write.statements
					)) ?? write.estimate);
			budget.spend(written);
			done++;
			console.log(`✓ ${label}  ${write.summary}  (${written} rows)`);
		} catch (error) {
			console.error(
				`✗ ${label}: ${error instanceof Error ? error.message : error}`
			);
		}
	}

	const verb = options.dryRun ? 'would be written' : 'written';
	console.log(
		`\n${done} done, ${queue.length - done} remaining. ${budget.describe()} ${verb}.`
	);
}
