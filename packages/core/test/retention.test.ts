import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { catalogueTestDatabase, ids } from './fixture.js';
import type { TestDatabase } from './d1.js';
import { listDocuments } from '../works/index.js';
import { pruneConversations } from '../conversations/index.js';

/**
 * The job that makes the privacy page true: a conversation is deleted 30 days
 * after its last message, with everything hanging off it — and the ledger
 * that bills a reader's month is not.
 */

let db: TestDatabase;
let documentId: string;

const daysAgo = (n: number) =>
	new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

function reader(id: string, email = `${id}@readers.test`) {
	db.raw
		.prepare(
			`INSERT INTO users (id, email, first_seen, last_seen) VALUES (?, ?, ?, ?)`
		)
		.run(id, email, daysAgo(90), daysAgo(0));
}

/** A conversation last written in `age` days ago, with a message, a citation and its ledger row. */
function conversation(
	id: string,
	userId: string,
	age: number,
	deleted = false
) {
	const at = daysAgo(age);
	db.raw
		.prepare(
			`INSERT INTO conversations (id, user_id, model_id, created_at, updated_at, deleted_at)
			 VALUES (?, ?, 'gpt-5.6-luna', ?, ?, ?)`
		)
		.run(id, userId, at, at, deleted ? daysAgo(0) : null);
	db.raw
		.prepare(
			`INSERT INTO messages (id, conversation_id, seq, role, parts, created_at)
			 VALUES (?, ?, 1, 'assistant', '[]', ?)`
		)
		.run(`m-${id}`, id, at);
	db.raw
		.prepare(
			`INSERT INTO citations (id, message_id, document_id, page_no, quote, status, created_at)
			 VALUES (?, ?, ?, 3, 'words', 'verified', ?)`
		)
		.run(`q-${id}`, `m-${id}`, documentId, at);
	db.raw
		.prepare(
			`INSERT INTO usage_events (id, user_id, billing_month, kind, conversation_id, message_id, created_at)
			 VALUES (?, ?, ?, 'chat_turn', ?, ?, ?)`
		)
		.run(`u-${id}`, userId, at.slice(0, 7), id, `m-${id}`, at);
}

const count = (table: string) =>
	(
		db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
			n: number;
		}
	).n;

const remaining = () =>
	(
		db.raw.prepare(`SELECT id FROM conversations ORDER BY id`).all() as {
			id: string;
		}[]
	).map((row) => row.id);

beforeEach(async () => {
	db = catalogueTestDatabase();
	[{ id: documentId }] = await listDocuments(
		db.d1,
		ids.bookBeyondGoodAndEvil
	);
	reader('ada');
	reader('op', 'op@readers.test');
});

afterEach(() => db.close());

describe('pruneConversations', () => {
	it('deletes a conversation 30 days after its last message, and not before', async () => {
		conversation('old', 'ada', 31);
		conversation('recent', 'ada', 29);

		expect(await pruneConversations(db.d1)).toBe(1);
		expect(remaining()).toEqual(['recent']);
	});

	it('takes its messages and citations with it', async () => {
		conversation('old', 'ada', 31);
		await pruneConversations(db.d1);

		expect(count('messages')).toBe(0);
		expect(count('citations')).toBe(0);
	});

	// The ledger has no foreign key to conversations on purpose. If one is
	// ever added, this fails, and it should: pruning would reset every
	// reader's month and wipe the billing record with it.
	it('leaves the ledger exactly as it was', async () => {
		conversation('old', 'ada', 31);
		conversation('recent', 'ada', 2);
		await pruneConversations(db.d1);

		expect(count('usage_events')).toBe(2);
	});

	it('deletes a conversation its reader deleted, whatever its age', async () => {
		conversation('binned', 'ada', 1, true);
		await pruneConversations(db.d1);
		expect(remaining()).toEqual([]);
	});

	it('spares the admin’s history', async () => {
		conversation('notes', 'op', 400);
		conversation('old', 'ada', 31);
		await pruneConversations(db.d1, { spare: 'op@readers.test' });

		expect(remaining()).toEqual(['notes']);
	});

	it('works through more than one slice', async () => {
		for (let i = 0; i < 450; i++)
			conversation(`c${String(i).padStart(3, '0')}`, 'ada', 40);
		expect(await pruneConversations(db.d1)).toBe(450);
		expect(remaining()).toEqual([]);
	});
});
