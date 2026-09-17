/// <reference types="@cloudflare/workers-types" />
/**
 * A D1Database implementation backed by node:sqlite, for tests.
 *
 * Only the surface this codebase actually uses is implemented:
 * prepare().bind().all() / .first() / .run(), plus result.meta.changes.
 * Behavioural differences from D1 that matter are emulated deliberately —
 * see coerce() and toPlain().
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(
	import.meta.dirname,
	'../../../sql/migrations'
);
const SEARCH_SCHEMA_DIR = path.resolve(
	import.meta.dirname,
	'../../../sql/search'
);

/** D1 accepts booleans and converts them; node:sqlite rejects them. */
function coerce(value: unknown): null | number | bigint | string | Uint8Array {
	if (value === undefined || value === null) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	return value as number | bigint | string | Uint8Array;
}

/** node:sqlite returns null-prototype objects, which break deep equality. */
function toPlain<T>(row: unknown): T {
	return row == null ? (row as T) : ({ ...(row as object) } as T);
}

class TestStatement {
	constructor(
		private readonly db: DatabaseSync,
		private readonly sql: string,
		private readonly params: unknown[] = []
	) {}

	bind(...params: unknown[]): TestStatement {
		return new TestStatement(this.db, this.sql, params);
	}

	private stmt() {
		return this.db.prepare(this.sql);
	}

	private args() {
		return this.params.map(coerce);
	}

	async all<T = Record<string, unknown>>() {
		const rows = this.stmt().all(...this.args());
		return {
			success: true,
			results: rows.map((r) => toPlain<T>(r)),
			meta: {
				changes: 0,
				duration: 0,
				rows_read: rows.length,
				rows_written: 0,
			},
		};
	}

	async first<T = Record<string, unknown>>(column?: string) {
		const row = this.stmt().get(...this.args());
		if (row === undefined) return null;
		const plain = toPlain<Record<string, unknown>>(row);
		return (column ? (plain[column] ?? null) : plain) as T;
	}

	async run() {
		const result = this.stmt().run(...this.args());
		return {
			success: true,
			results: [],
			meta: {
				changes: Number(result.changes),
				last_row_id: Number(result.lastInsertRowid),
				duration: 0,
				rows_read: 0,
				rows_written: Number(result.changes),
			},
		};
	}
}

export interface TestDatabase {
	/** The D1Database-shaped handle to pass into production code. */
	d1: D1Database;
	/** Escape hatch for fixture setup and assertions. */
	raw: DatabaseSync;
	close(): void;
}

export function createTestDatabase(): TestDatabase {
	const raw = new DatabaseSync(':memory:');
	raw.exec('PRAGMA foreign_keys = ON');
	const d1 = {
		prepare: (sql: string) => new TestStatement(raw, sql),
		// D1 runs a batch as one transaction: all statements land, or none do.
		batch: async (statements: TestStatement[]) => {
			raw.exec('BEGIN');
			try {
				const results = [];
				for (const statement of statements) {
					results.push(await statement.run());
				}
				raw.exec('COMMIT');
				return results;
			} catch (error) {
				raw.exec('ROLLBACK');
				throw error;
			}
		},
	} as unknown as D1Database;
	return { d1, raw, close: () => raw.close() };
}

function listSqlFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
}

export function listMigrations(): string[] {
	return listSqlFiles(MIGRATIONS_DIR);
}

/** The FTS database behind the SEARCH binding, built from sql/search/. */
export function searchTestDatabase(): TestDatabase {
	const db = createTestDatabase();
	for (const file of listSqlFiles(SEARCH_SCHEMA_DIR)) {
		db.raw.exec(readFileSync(path.join(SEARCH_SCHEMA_DIR, file), 'utf8'));
	}
	return db;
}

export interface MigrationRange {
	/** Inclusive; matched as a filename prefix, e.g. "0026". */
	from?: string;
	/** Inclusive; matched as a filename prefix. */
	to?: string;
}

/**
 * Apply migrations in order. Tests build their schema exactly the way
 * production got its schema, so a migration that drifts from the code fails
 * here rather than in production.
 */
export function applyMigrations(
	db: TestDatabase,
	range: MigrationRange = {}
): void {
	db.raw.exec('PRAGMA foreign_keys = OFF');
	for (const file of listMigrations()) {
		if (range.from && file < range.from) continue;
		if (range.to && file > range.to && !file.startsWith(range.to)) break;
		db.raw.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
	}
	db.raw.exec('PRAGMA foreign_keys = ON');
}

export function migratedTestDatabase(range: MigrationRange = {}): TestDatabase {
	const db = createTestDatabase();
	applyMigrations(db, range);
	return db;
}
