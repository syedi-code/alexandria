import { describe, it, expect } from 'vitest';
import { cacheShare, costOf } from '@alexandria/core/platform';
import { byModel, rowCost, totalOf, type SpendRow } from './spend-report.js';

const row = (over: Partial<SpendRow>): SpendRow => ({
	email: 'reader@example.com',
	model_id: 'gpt-5.6-sol',
	turns: 1,
	input_tokens: 0,
	cache_read_tokens: 0,
	cache_write_tokens: 0,
	output_tokens: 0,
	last_turn: '2026-09-23T00:00:00Z',
	...over,
});

// Priced by hand at the rates in PRICES, 2026-09-23.
const sol = row({
	model_id: 'gpt-5.6-sol',
	turns: 10,
	input_tokens: 1_000_000,
	cache_read_tokens: 800_000,
	cache_write_tokens: 100_000,
	output_tokens: 50_000,
});
// 100k uncached × $4 + 800k cached × $0.40 + 100k written × $4 + 50k out × $20
const SOL_COST = 0.4 + 0.32 + 0.4 + 1.0;

const sonnet = row({
	model_id: 'claude-sonnet-5',
	turns: 2,
	input_tokens: 200_000,
	cache_read_tokens: 20_000,
	cache_write_tokens: 40_000,
	output_tokens: 10_000,
});
// 140k uncached × $2 + 20k cached × $0.20 + 40k written × $2.50 + 10k out × $10
const SONNET_COST = 0.28 + 0.004 + 0.1 + 0.1;

describe('costOf', () => {
	it('prices cache reads and writes at their own rates, to the cent', () => {
		expect(rowCost(sol)).toBeCloseTo(SOL_COST, 2);
		expect(rowCost(sonnet)).toBeCloseTo(SONNET_COST, 2);
	});

	it('charges a cache read less than the same token uncached', () => {
		const tokens = {
			input: 1_000_000,
			cacheRead: 0,
			cacheWrite: 0,
			output: 0,
		};
		const cached = { ...tokens, cacheRead: 1_000_000 };
		expect(costOf('gpt-5.6-luna', cached)!).toBeLessThan(
			costOf('gpt-5.6-luna', tokens)!
		);
	});

	it('has no price for a model with no rate, rather than zero', () => {
		expect(
			rowCost(row({ model_id: 'gpt-9-unknown', input_tokens: 5 }))
		).toBeNull();
		expect(rowCost(row({ model_id: null }))).toBeNull();
	});
});

describe('cacheShare', () => {
	it('is the share of input read from the cache', () => {
		expect(
			cacheShare({
				input: 1_000,
				cacheRead: 800,
				cacheWrite: 0,
				output: 0,
			})
		).toBe(0.8);
	});

	it('is unknown with no input', () => {
		expect(
			cacheShare({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
		).toBeNull();
	});
});

describe('the report', () => {
	it('sums every reader of a model before pricing it', () => {
		const other = { ...sol, email: 'other@example.com' };
		const [model] = byModel([sol, other]);
		expect(model.turns).toBe(20);
		expect(model.cost).toBeCloseTo(SOL_COST * 2, 2);
		expect(model.cacheShare).toBe(0.8);
	});

	it('names a model it cannot price, and leaves it out of the total', () => {
		const unknown = row({
			model_id: 'gpt-9-unknown',
			input_tokens: 1_000_000,
		});
		const { cost, unpriced } = totalOf([sol, sonnet, unknown]);
		expect(cost).toBeCloseTo(SOL_COST + SONNET_COST, 2);
		expect(unpriced).toEqual(['gpt-9-unknown']);
	});
});
