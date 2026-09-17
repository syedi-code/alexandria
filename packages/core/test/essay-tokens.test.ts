import { describe, it, expect } from 'vitest';
import {
	parseEssayToken,
	serializeToken,
	validateParams,
	parseEssayTokens,
	EMBED_PARAM_SPECS,
	apiContract,
	type EmbedParamSpecs,
} from '../index.js';

const ID = '9f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607';

describe('the token grammar', () => {
	it('parses a bare token', () => {
		expect(parseEssayToken(`[[book:${ID}]]`)).toMatchObject({
			kind: 'book',
			id: ID,
			params: {},
		});
	});

	it('clamps an int param to the spec bounds', () => {
		expect(parseEssayToken(`[[quote:${ID} size=999]]`)?.params).toEqual({
			size: 48,
		});
	});

	it('drops an unknown key and an out-of-vocabulary enum value', () => {
		expect(
			parseEssayToken(`[[image:${ID} bg=sepia nonsense=1]]`)?.params
		).toEqual({});
	});

	it('round-trips through serialize', () => {
		const token = parseEssayToken(
			`[[image:${ID} bg=light caption="A plate"]]`
		)!;
		expect(serializeToken(token)).toBe(
			`[[image:${ID} bg=light caption="A plate"]]`
		);
	});
});

/**
 * The vocabulary travels over the wire while the machinery is shipped in the
 * client (plan D20), so every entry point has to honour a spec table it was
 * handed rather than the one it was compiled with. Otherwise adding a param
 * server-side would silently do nothing.
 */
describe('a spec table from the server', () => {
	const withSepia: EmbedParamSpecs = {
		...EMBED_PARAM_SPECS,
		image: [
			{
				key: 'bg',
				type: 'enum',
				enumValues: ['dark', 'light', 'none', 'sepia'],
				default: 'dark',
				description: 'Slide background',
			},
		],
	};

	it('is honoured by parseEssayToken', () => {
		expect(
			parseEssayToken(`[[image:${ID} bg=sepia]]`, withSepia)?.params
		).toEqual({ bg: 'sepia' });
	});

	it('is honoured by validateParams', () => {
		expect(validateParams('image', { bg: 'sepia' }, withSepia)).toEqual({
			bg: 'sepia',
		});
	});

	it('is honoured by serializeToken', () => {
		const token = parseEssayToken(`[[image:${ID} bg=sepia]]`, withSepia)!;
		expect(serializeToken(token, withSepia)).toBe(
			`[[image:${ID} bg=sepia]]`
		);
	});

	it('is honoured by parseEssayTokens', () => {
		expect(
			parseEssayTokens(`intro\n\n[[image:${ID} bg=sepia]]`, withSepia)
		).toEqual([
			{
				entity_type: 'image',
				entity_id: ID,
				position: 1,
				params: { bg: 'sepia' },
			},
		]);
	});
});

describe('the API contract payload', () => {
	it('carries the limits and the vocabulary, and nothing else', () => {
		expect(Object.keys(apiContract()).sort()).toEqual([
			'embed_param_specs',
			'limits',
		]);
	});

	it('is pure data — it survives a JSON round trip unchanged', () => {
		const contract = apiContract();
		expect(JSON.parse(JSON.stringify(contract))).toEqual(
			JSON.parse(JSON.stringify(contract))
		);
		expect(JSON.stringify(contract)).toContain('"embed_param_specs"');
	});
});
