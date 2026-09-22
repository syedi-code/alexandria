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
	// Ten is a trial, not a tier: enough to ask a real question, read the
	// pages it cites and judge the verification, and not enough to live on.
	free: 10,
	// Sized so a reader who asks every question of Sonnet 5 still costs less
	// than the $20 they pay: about $0.06-0.12 a question at September 2026
	// prices. Raise it once the ledger shows what paid readers really cost.
	paid: 150,
} as const;

/**
 * Whether a plan opens the scan of a cited page. One page at a time, and only
 * a page the reader's own citations point at; the whole file is the admin's.
 */
export const PAGE_SCANS = { free: false, paid: true } as const;
