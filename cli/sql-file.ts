import {
	D1_MAX_STATEMENT_BYTES,
	type SqlStatement,
	type SqlValue,
} from '@alexandria/core/platform';

function literal(value: SqlValue): string {
	if (value === null) return 'NULL';
	if (typeof value === 'number') {
		if (!Number.isFinite(value))
			throw new Error(`Cannot write ${value} to SQL`);
		return String(value);
	}
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * `wrangler d1 execute --file` takes SQL text, not bound parameters, so each
 * `?` is replaced by its value as a literal. Statements built in core never
 * put a `?` inside a string literal, which is what makes this substitution safe.
 */
export function renderStatement({ sql, params }: SqlStatement): string {
	let next = 0;
	const rendered = sql.replace(/\?/g, () => {
		if (next >= params.length)
			throw new Error('More placeholders than parameters');
		return literal(params[next++]);
	});
	if (next !== params.length)
		throw new Error('More parameters than placeholders');

	const bytes = Buffer.byteLength(rendered);
	if (bytes > D1_MAX_STATEMENT_BYTES) {
		throw new Error(
			`A statement is ${bytes} bytes; D1 accepts at most ${D1_MAX_STATEMENT_BYTES}.`
		);
	}
	return `${rendered};`;
}

export const renderSqlFile = (statements: readonly SqlStatement[]) =>
	statements.map(renderStatement).join('\n') + '\n';
