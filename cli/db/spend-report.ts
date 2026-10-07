import {
	cacheShare,
	costOf,
	type TokenCounts,
} from '@alexandria/core/platform';

/** One group of `usage_events`: a reader and a model, and a week when broken down. */
export interface SpendRow {
	email: string;
	model_id: string | null;
	billing_week?: string;
	turns: number;
	input_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	output_tokens: number;
	last_turn: string | null;
}

export const tokensOf = (row: SpendRow): TokenCounts => ({
	input: row.input_tokens,
	cacheRead: row.cache_read_tokens,
	cacheWrite: row.cache_write_tokens,
	output: row.output_tokens,
});

export const rowCost = (row: SpendRow) => costOf(row.model_id, tokensOf(row));

export interface ModelTotal extends TokenCounts {
	model_id: string | null;
	turns: number;
	cost: number | null;
	cacheShare: number | null;
}

/** Every reader's rows for one model, summed, priced and with its cache share. */
export function byModel(rows: SpendRow[]): ModelTotal[] {
	const totals = new Map<string | null, ModelTotal>();
	for (const row of rows) {
		const total = totals.get(row.model_id) ?? {
			model_id: row.model_id,
			turns: 0,
			input: 0,
			cacheRead: 0,
			cacheWrite: 0,
			output: 0,
			cost: null,
			cacheShare: null,
		};
		total.turns += row.turns;
		total.input += row.input_tokens;
		total.cacheRead += row.cache_read_tokens;
		total.cacheWrite += row.cache_write_tokens;
		total.output += row.output_tokens;
		totals.set(row.model_id, total);
	}
	return [...totals.values()]
		.map((total) => ({
			...total,
			cost: costOf(total.model_id, total),
			cacheShare: cacheShare(total),
		}))
		.sort((a, b) => b.turns - a.turns);
}

/**
 * The priced total, and the models that could not be priced. A model with no
 * rate is named rather than counted as free, so a total is never quietly low.
 */
export function totalOf(rows: SpendRow[]): {
	cost: number;
	unpriced: (string | null)[];
} {
	const models = byModel(rows);
	return {
		cost: models.reduce((n, m) => n + (m.cost ?? 0), 0),
		unpriced: models.filter((m) => m.cost === null).map((m) => m.model_id),
	};
}
