/// <reference types="@cloudflare/workers-types" />

/**
 * Guests: a visitor who has not signed in, with a few questions to try Scribe
 * before they do (scribe#38). Each is a `users` row with `is_guest = 1`, so
 * the session, the chat route and the ledger need nothing new; what is new is
 * how one is made, how many one address may make, and what happens to one on
 * sign-in or neglect.
 */

/** Questions a guest may ask, ever — not a month, or they would get more each month. */
export const GUEST_TURNS = 3;

/**
 * Guests one address may make in a UTC day. Anyone can clear their cookies
 * and be a new guest, and every guest question costs money; Turnstile stops
 * scripts, and this stops a person with a script and patience. Five leaves
 * room for a household or a library behind one address.
 */
export const GUESTS_PER_ADDRESS_PER_DAY = 5;

/** How long an unused guest is kept before the daily job removes it. */
export const GUEST_RETENTION_DAYS = 30;

export const guestEmail = (id: string) => `${id}@guest.invalid`;

/**
 * An address, as the cap table stores it: an HMAC under a secret the database
 * does not hold. The same address hashes the same way every day, so the cap
 * works, and a copy of the table cannot be turned back into addresses.
 */
export async function hashAddress(
	address: string,
	secret: string
): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`guest-address:${address}`)
	);
	return [...new Uint8Array(mac)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Count one more guest against an address for today, and say whether it is
 * within the cap. The increment and the read are one statement, so two
 * requests at once cannot both be let in as the fifth.
 */
export async function admitGuestFrom(
	db: D1Database,
	addressHash: string,
	at: Date = new Date()
): Promise<boolean> {
	const day = at.toISOString().slice(0, 10);
	const row = await db
		.prepare(
			`INSERT INTO guest_ips (ip_hash, day, count) VALUES (?, ?, 1)
			 ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1
			 RETURNING count`
		)
		.bind(addressHash, day)
		.first<{ count: number }>();
	return (row?.count ?? Infinity) <= GUESTS_PER_ADDRESS_PER_DAY;
}

/** A new guest. The id is random, so a guest can never be guessed or claimed. */
export async function createGuest(db: D1Database): Promise<{
	id: string;
	email: string;
}> {
	const id = `guest-${crypto.randomUUID()}`;
	const email = guestEmail(id);
	const now = new Date().toISOString();
	await db
		.prepare(
			`INSERT INTO users (id, email, first_seen, last_seen, is_guest)
			 VALUES (?, ?, ?, ?, 1)`
		)
		.bind(id, email, now, now)
		.run();
	return { id, email };
}

export async function isGuest(
	db: D1Database,
	userId: string
): Promise<boolean> {
	const row = await db
		.prepare(`SELECT is_guest FROM users WHERE id = ?`)
		.bind(userId)
		.first<{ is_guest: number }>();
	return row?.is_guest === 1;
}

/**
 * A guest has signed in: their conversations and the questions they asked
 * move to the account, and the guest is gone. One batch, so it happens whole
 * or not at all — half a move would leave a reader's conversations with a
 * user that no longer exists.
 *
 * The ledger rows move rather than vanish, so the three questions count
 * against the account's month: signing in is not a way to get them back.
 *
 * Refuses unless `guestId` really is a guest, so this can never be pointed
 * at a real account and empty it into someone else's.
 */
export async function adoptGuest(
	db: D1Database,
	guestId: string,
	userId: string
): Promise<boolean> {
	if (guestId === userId || !(await isGuest(db, guestId))) return false;
	await db.batch([
		db
			.prepare(`UPDATE conversations SET user_id = ? WHERE user_id = ?`)
			.bind(userId, guestId),
		db
			.prepare(`UPDATE usage_events SET user_id = ? WHERE user_id = ?`)
			.bind(userId, guestId),
		db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(guestId),
		db
			.prepare(`DELETE FROM users WHERE id = ? AND is_guest = 1`)
			.bind(guestId),
	]);
	return true;
}

/**
 * Remove guests nobody has used in `days`: made that long ago, and no
 * conversation of theirs touched since. With them go their conversations,
 * their ledger rows — a guest's questions bill nobody — and their sessions.
 */
export async function pruneGuests(
	db: D1Database,
	days = GUEST_RETENTION_DAYS
): Promise<number> {
	const { results } = await db
		.prepare(
			`SELECT u.id FROM users u
			  WHERE u.is_guest = 1
			    AND julianday(u.first_seen) <= julianday('now', ?)
			    AND NOT EXISTS (
			      SELECT 1 FROM conversations c
			       WHERE c.user_id = u.id
			         AND julianday(c.updated_at) > julianday('now', ?))
			  LIMIT 200`
		)
		.bind(`-${days} days`, `-${days} days`)
		.all<{ id: string }>();

	const ids = (results ?? []).map((row) => row.id);
	for (const id of ids) {
		await db.batch([
			db.prepare(`DELETE FROM conversations WHERE user_id = ?`).bind(id),
			db.prepare(`DELETE FROM usage_events WHERE user_id = ?`).bind(id),
			db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id),
			db
				.prepare(`DELETE FROM users WHERE id = ? AND is_guest = 1`)
				.bind(id),
		]);
	}
	return ids.length;
}
