/** Shared max-length constants for Zod schemas and frontend enforcement. */
export const MAX_LENGTHS = {
	/** Long-form user content: notes, quotes, bios, descriptions */
	CONTENT: 3_000,
	/** Essay body — long-form composition with embeds and headers */
	ESSAY: 20_000,
	/** Titles, names, creator fields */
	TITLE: 500,
	/** Short metadata: source, page, isbn, born/died dates */
	SHORT: 200,
	/** UUIDs and foreign-key IDs */
	ID: 100,
	/** URLs (pdf_url, cover_url, link url, etc.) */
	URL: 2_000,
	/** JSON-serialised tag arrays */
	TAGS: 1_000,
} as const;

/**
 * Turns a reader gets each calendar month, by plan.
 *
 * `paid` has a number too. An unlimited tier is a tier where one loop costs
 * you without bound; this number exists to be raised when someone reaches it,
 * not to be removed. The admin is exempt by role, not by plan.
 */
export const TURNS_PER_MONTH = {
	// TEMPORARY — 2026-09-20. Lowered from 20 so the 402 can be reached in
	// five turns while the limit is being tested on a member account. Put it
	// back to 20 before anyone else is let in; a free tier of five is a demo
	// that ends before it has shown anything.
	free: 5,
	paid: 500,
} as const;

/** What `free` goes back to once the limit has been tested. */
export const FREE_TURNS_PER_MONTH_AFTER_TESTING = 20;
