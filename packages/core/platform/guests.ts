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
 * Guests one address may make in a UTC day.
 *
 * This is not a cost control and must not be sized like one. Turnstile is the
 * real defence and runs before a guest is made; what is left for this to stop
 * is one person with a script and patience, and three turns on the cheapest
 * model is about $0.06 a guest — so a hundred from one address in a day is
 * about $6, which is an absurd amount of deliberate effort for the result.
 *
 * It was five, on the reasoning that five leaves room for a household. A
 * university campus is not a household: thousands of people share a handful
 * of addresses behind NAT, and a mobile carrier puts a whole city behind
 * CGNAT. At five, the sixth person on a campus network to open Scribe on a
 * given day was refused — and refused invisibly, because a guest that cannot
 * be made leaves the reader in the `none` state with no explanation. That is
 * the launch audience, turned away by a constant.
 *
 * The bound that actually protects the bill is `GUESTS_PER_DAY` below, which
 * does not care how the addresses are distributed.
 */
export const GUESTS_PER_ADDRESS_PER_DAY = 100;

/**
 * Guests made in a UTC day, across every address. This is the real cost
 * ceiling, and it fails closed for new visitors — so it belongs well above
 * any plausible day rather than close to one, and it logs loudly when it
 * trips, because the day it fires is a day Scribe turned strangers away.
 */
export const GUESTS_PER_DAY = 2_000;

/** The row `guest_ips` keeps the day's total in. Not a hash, so it can never collide with one. */
const ALL_ADDRESSES = 'all';

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
 * within both bounds. Each increment and its read are one statement, so two
 * requests at once cannot both be let in as the last one allowed.
 *
 * A refusal is logged rather than only returned. A blocked address is
 * invisible from the outside — the reader gets no error worth reading and the
 * maintainer gets nothing at all — and the whole failure this replaces was
 * one nobody could see.
 */
export async function admitGuestFrom(
	db: D1Database,
	addressHash: string,
	at: Date = new Date()
): Promise<boolean> {
	const day = at.toISOString().slice(0, 10);
	const count = async (key: string) => {
		const row = await db
			.prepare(
				`INSERT INTO guest_ips (ip_hash, day, count) VALUES (?, ?, 1)
				 ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1
				 RETURNING count`
			)
			.bind(key, day)
			.first<{ count: number }>();
		return row?.count ?? Infinity;
	};

	const today = await count(ALL_ADDRESSES);
	if (today > GUESTS_PER_DAY) {
		console.warn(
			`[guests] the day's ceiling is reached: ${today} of ${GUESTS_PER_DAY}. New visitors are being turned away.`
		);
		return false;
	}

	const fromHere = await count(addressHash);
	if (fromHere > GUESTS_PER_ADDRESS_PER_DAY) {
		console.warn(
			`[guests] ${addressHash.slice(0, 12)}… refused: ${fromHere} today, over ${GUESTS_PER_ADDRESS_PER_DAY}. A shared address behind NAT looks like this.`
		);
		return false;
	}
	return true;
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
