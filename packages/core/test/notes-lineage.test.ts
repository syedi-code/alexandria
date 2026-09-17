import { describe, it, expect } from 'vitest';
import type { NoteRow } from '../writing/schema.js';
import { projectNoteLineage } from '../writing/notes.js';

function note(
	overrides: Partial<NoteRow> & Pick<NoteRow, 'id' | 'created_at'>
): NoteRow {
	return {
		content: overrides.id,
		posted: 0,
		source: 'test',
		updated_at: overrides.created_at,
		...overrides,
	};
}

describe('projectNoteLineage', () => {
	it('projects a version head as one logical note with its original date', () => {
		const surfacedAt = '2026-07-12T18:10:07.730Z';
		const root = note({
			id: 'note-root',
			created_at: '2024-01-01T12:00:00.000Z',
			last_surfaced_at: surfacedAt,
		});
		const second = note({
			id: 'note-v2',
			created_at: '2025-01-01T12:00:00.000Z',
			replaces: root.id,
		});
		const head = note({
			id: 'note-v3',
			content: 'current text',
			created_at: '2026-08-09T12:00:00.000Z',
			replaces: second.id,
			last_surfaced_at: surfacedAt,
		});

		expect(projectNoteLineage([head], [root, second])).toStrictEqual([
			{ ...head, version: 3, originalCreatedAt: root.created_at },
		]);
	});

	it('does not cross a missing or tenant-filtered lineage boundary', () => {
		const head = note({
			id: 'note-v2',
			created_at: '2026-08-09T12:00:00.000Z',
			replaces: 'another-users-note',
		});

		expect(projectNoteLineage([head], [])).toStrictEqual([
			{ ...head, version: 1, originalCreatedAt: head.created_at },
		]);
	});
});
