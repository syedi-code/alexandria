/// <reference types="@cloudflare/workers-types" />
import type { AccessAuditLogInput, AccessAuditLogRow } from './schema.js';

/**
 * Create an append-only audit log entry for a blocked cross-tenant access attempt.
 */
export async function createAuditLogEntry(
	db: D1Database,
	input: AccessAuditLogInput
): Promise<AccessAuditLogRow> {
	const id = crypto.randomUUID();
	const created_at = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO access_audit_log (id, created_at, user_id, user_tenant_id, target_entity_type, target_entity_id, target_tenant_id, action, outcome, metadata)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			id,
			created_at,
			input.user_id,
			input.user_tenant_id,
			input.target_entity_type,
			input.target_entity_id,
			input.target_tenant_id ?? null,
			input.action,
			input.outcome,
			input.metadata ?? null
		)
		.run();

	return { id, created_at, ...input };
}

/**
 * Query audit log entries with pagination, date range, and action filter.
 */
export async function getAuditLogEntries(
	db: D1Database,
	options: {
		limit?: number;
		offset?: number;
		from?: string;
		to?: string;
		action?: 'READ' | 'UPDATE' | 'DELETE';
	} = {}
): Promise<{ data: AccessAuditLogRow[]; hasMore: boolean }> {
	const limit = options.limit ?? 50;
	const offset = options.offset ?? 0;

	let query = `SELECT * FROM access_audit_log WHERE 1=1`;
	const params: (string | number)[] = [];

	if (options.from) {
		query += ` AND created_at >= ?`;
		params.push(options.from);
	}
	if (options.to) {
		query += ` AND created_at <= ?`;
		params.push(options.to);
	}
	if (options.action) {
		query += ` AND action = ?`;
		params.push(options.action);
	}

	query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
	params.push(limit + 1, offset);

	const result = await db
		.prepare(query)
		.bind(...params)
		.all<AccessAuditLogRow>();

	const rows = result.results ?? [];
	const hasMore = rows.length > limit;
	return { data: hasMore ? rows.slice(0, limit) : rows, hasMore };
}
