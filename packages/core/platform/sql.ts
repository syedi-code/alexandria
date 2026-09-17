/// <reference types="@cloudflare/workers-types" />

export type SqlValue = string | number | null;

/**
 * A statement kept as data rather than as a prepared D1 statement, so the same
 * write can run through a binding in the worker or be rendered into a SQL file
 * for `wrangler d1 execute` by the CLI.
 */
export interface SqlStatement {
	sql: string;
	params: SqlValue[];
}

export const D1_MAX_BOUND_PARAMETERS = 100;
export const D1_MAX_STATEMENT_BYTES = 100_000;

/** Headroom under the statement limit for the SQL text and literal quoting. */
const INSERT_PAYLOAD_BYTES = 80_000;

const encoder = new TextEncoder();

function byteLength(value: SqlValue): number {
	return typeof value === 'string' ? encoder.encode(value).length : 8;
}

/**
 * Multi-row INSERTs, split so that no statement exceeds D1's bound-parameter or
 * statement-size limits. A single row larger than the payload budget still gets
 * a statement of its own; it cannot be split.
 */
export function insertRows(
	table: string,
	columns: readonly string[],
	rows: readonly SqlValue[][],
	suffix = ''
): SqlStatement[] {
	const rowsPerStatement = Math.floor(
		D1_MAX_BOUND_PARAMETERS / columns.length
	);
	const placeholder = `(${columns.map(() => '?').join(', ')})`;
	const statements: SqlStatement[] = [];

	let batch: SqlValue[][] = [];
	let batchBytes = 0;

	const flush = () => {
		if (batch.length === 0) return;
		statements.push({
			sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${batch
				.map(() => placeholder)
				.join(', ')}${suffix ? ` ${suffix}` : ''}`,
			params: batch.flat(),
		});
		batch = [];
		batchBytes = 0;
	};

	for (const row of rows) {
		const rowBytes = row.reduce<number>(
			(sum, value) => sum + byteLength(value),
			0
		);
		if (
			batch.length === rowsPerStatement ||
			(batch.length > 0 && batchBytes + rowBytes > INSERT_PAYLOAD_BYTES)
		) {
			flush();
		}
		batch.push(row);
		batchBytes += rowBytes;
	}
	flush();

	return statements;
}

/** Runs statements as one D1 batch (a single transaction) and reports rows written. */
export async function runStatements(
	db: D1Database,
	statements: readonly SqlStatement[]
): Promise<number> {
	if (statements.length === 0) return 0;
	const results = await db.batch(
		statements.map(({ sql, params }) => db.prepare(sql).bind(...params))
	);
	return results.reduce((sum, r) => sum + (r.meta?.rows_written ?? 0), 0);
}
