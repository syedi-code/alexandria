/**
 * What a model charges, in dollars per million tokens, at the standard tier.
 *
 * Prices move, and this table is the only place to correct them: the spend
 * report and anything else that puts a dollar figure on a turn reads it, and
 * nothing keeps a rate of its own. Each entry carries the date it was last
 * checked against the provider's own pricing page, so a stale one says so.
 *
 * `cacheWrite` is what a token written to the cache costs. Anthropic charges
 * 1.25× input for it; OpenAI and Google charge nothing extra, so theirs is the
 * input rate.
 */
export interface ModelPrice {
	input: number;
	cachedInput: number;
	cacheWrite: number;
	output: number;
	/** 'YYYY-MM-DD' the rates were last read off the provider's page. */
	checked: string;
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
	'gpt-5.6-luna': {
		input: 0.2,
		cachedInput: 0.02,
		cacheWrite: 0.2,
		output: 1.2,
		checked: '2026-09-23',
	},
	'gpt-5.6-terra': {
		input: 2,
		cachedInput: 0.2,
		cacheWrite: 2,
		output: 12,
		checked: '2026-09-23',
	},
	'gpt-5.6-sol': {
		input: 4,
		cachedInput: 0.4,
		cacheWrite: 4,
		output: 20,
		checked: '2026-09-23',
	},
	'claude-haiku-4-5-20251001': {
		input: 1,
		cachedInput: 0.1,
		cacheWrite: 1.25,
		output: 5,
		checked: '2026-09-23',
	},
	'claude-sonnet-5': {
		input: 2,
		cachedInput: 0.2,
		cacheWrite: 2.5,
		output: 10,
		checked: '2026-09-23',
	},
	'gemini-3.1-pro': {
		input: 2,
		cachedInput: 0.2,
		cacheWrite: 2,
		output: 12,
		checked: '2026-09-23',
	},
};

/**
 * Tokens as `usage_events` stores them. `input` is every input token the
 * provider counted, cached and written ones included — the AI SDK's
 * `inputTokens` — so the uncached part is what is left after both.
 */
export interface TokenCounts {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

/** Dollars for these tokens on this model, or null when it has no rate. */
export function costOf(
	modelId: string | null | undefined,
	tokens: TokenCounts
): number | null {
	const price = modelId ? PRICES[modelId] : undefined;
	if (!price) return null;
	const uncached = Math.max(
		0,
		tokens.input - tokens.cacheRead - tokens.cacheWrite
	);
	return (
		(uncached * price.input +
			tokens.cacheRead * price.cachedInput +
			tokens.cacheWrite * price.cacheWrite +
			tokens.output * price.output) /
		1_000_000
	);
}

/** The share of input served from the cache, 0–1, or null with no input. */
export const cacheShare = (tokens: TokenCounts): number | null =>
	tokens.input > 0 ? tokens.cacheRead / tokens.input : null;
