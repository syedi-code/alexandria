import { describe, expect, it } from 'vitest';
import { latestIds, latestRevisions } from './latest.js';

describe('latestIds', () => {
	it('maps every earlier version to the newest in its chain', () => {
		const latest = latestIds([
			{ id: 'b', replaces: 'a' },
			{ id: 'c', replaces: 'b' },
			{ id: 'x', replaces: null },
		]);
		expect(latest.get('a')).toBe('c');
		expect(latest.get('b')).toBe('c');
		expect(latest.has('c')).toBe(false);
		expect(latest.has('x')).toBe(false);
	});

	it('stops on a cycle', () => {
		const latest = latestIds([
			{ id: 'a', replaces: 'b' },
			{ id: 'b', replaces: 'a' },
		]);
		expect(latest.size).toBe(2);
	});
});

const thought = (id: string, created_at: string, content: string) => ({
	id,
	created_at,
	content,
});

describe('latestRevisions', () => {
	it('keeps only the newest draft of a reworded thought', () => {
		const rows = [
			thought(
				'3',
				'2026-01-13T17:19:00Z',
				"I keep coming back to Descartes' idea that dreams can be real and it keeps making me giggle."
			),
			thought(
				'2',
				'2026-01-13T17:12:00Z',
				"I keep coming back to Descartes' idea that dreams can be real and it makes me giggle..."
			),
			thought(
				'1',
				'2026-01-13T17:09:00Z',
				"I keep returning to Descartes' idea that dreams can be real and it makes me giggle..."
			),
		];
		const { latest, latestOf } = latestRevisions(rows);
		expect(latest.map((r) => r.id)).toEqual(['3']);
		expect(latestOf.get('1')).toBe('3');
		expect(latestOf.get('2')).toBe('3');
	});

	it('keeps an exact copy only once', () => {
		const text =
			'I keep trying to find ways for a lack of love to empower me.';
		const { latest } = latestRevisions([
			thought('discord', '2025-11-02T06:22:01Z', text),
			thought('web', '2025-11-02T06:22:00Z', text),
		]);
		expect(latest.map((r) => r.id)).toEqual(['discord']);
	});

	it('leaves short daily entries alone', () => {
		const { latest } = latestRevisions([
			thought('1', '2026-02-01T00:00:00Z', 'Went to work.'),
			thought('2', '2026-02-02T00:00:00Z', 'Went to work.'),
			thought('3', '2026-02-03T00:00:00Z', 'Went to work. Yeah.'),
		]);
		expect(latest).toHaveLength(3);
	});

	it('leaves different thoughts on one subject alone', () => {
		const { latest } = latestRevisions([
			thought(
				'1',
				'2026-03-01T00:00:00Z',
				'Last day of the bachelor party. Went home and slept for most of the afternoon.'
			),
			thought(
				'2',
				'2026-02-28T00:00:00Z',
				'Second day of the bachelor party. Went to an escape room and then went clubbing downtown.'
			),
		]);
		expect(latest).toHaveLength(2);
	});
});
