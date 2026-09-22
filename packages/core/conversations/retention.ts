/// <reference types="@cloudflare/workers-types" />

/**
 * How long a conversation is kept after its last message. The privacy page
 * promises this number; it is true because this job runs every day.
 */
export const CONVERSATION_RETENTION_DAYS = 30;

/** Deleted a slice at a time, so one run never asks D1 for an unbounded write. */
const SLICE = 200;
const MAX_SLICES = 25;

/**
 * Delete conversations nobody has written in for `days`, and every one its
 * reader deleted, whatever its age. Deleting the row is the whole of it:
 * messages cascade from the conversation and citations from the message.
 *
 * `usage_events` is untouched, deliberately. Its `conversation_id` has no
 * foreign key, so this cannot empty the ledger that counts a reader's month
 * and bills it; the tidy fix of adding one would reset everyone's quota
 * silently on the next run.
 *
 * `spare` is a reader whose history is kept whatever its age — the admin's,
 * whose conversations are the operator's working notes rather than a
 * reader's data held on their behalf.
 */
export async function pruneConversations(
	db: D1Database,
	{
		days = CONVERSATION_RETENTION_DAYS,
		spare = null,
	}: { days?: number; spare?: string | null } = {}
): Promise<number> {
	let removed = 0;
	for (let slice = 0; slice < MAX_SLICES; slice++) {
		const result = await db
			.prepare(
				`DELETE FROM conversations WHERE id IN (
				   SELECT c.id FROM conversations c
				     JOIN users u ON u.id = c.user_id
				    WHERE (c.deleted_at IS NOT NULL
				           OR julianday(c.updated_at) <= julianday('now', ?))
				      AND (? IS NULL OR u.email <> ?)
				    LIMIT ?
				 )`
			)
			.bind(`-${days} days`, spare, spare, SLICE)
			.run();
		const changed = result.meta?.changes ?? 0;
		removed += changed;
		if (changed < SLICE) break;
	}
	return removed;
}
