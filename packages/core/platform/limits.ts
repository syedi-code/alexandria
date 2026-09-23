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
 * Turns a reader gets each week, by plan.
 *
 * It was a calendar month, and the month was wrong twice over. The number was
 * sized on an average turn of 50k input tokens, and the production ledger says
 * a real one is about 100k for the heavier models — so a Pro question costs
 * about $0.20-0.28, not the $0.06-0.12 the 150 was drawn from, and 150 of them
 * is $30-41 against the $19 that survives Stripe's fees. And a month lets one
 * reader spend the whole allowance in two days and then sit locked out for
 * twenty-eight, which is the cost and an angry reader from one event.
 *
 * A week bounds both to a quarter. These are the defaults; the live numbers
 * are `allowanceFor()` in `usage.ts`, which reads the `settings` table first,
 * so an allowance can be turned the day the ledger asks for it.
 *
 * `paid` has a number too. An unlimited tier is a tier where one loop costs
 * you without bound; this number exists to be raised when someone reaches it,
 * not to be removed. The admin is exempt by role, not by plan.
 */
export const TURNS_PER_WEEK = {
	// Free is derived from paid rather than set, so an advertised "about a
	// tenth of Pro" cannot drift when Pro is tuned. Three a week is a trial:
	// enough to ask a real question, read the pages it cites and judge the
	// verification, and not enough to live on.
	free: 3,
	// ~108 a month. Worst case, every one of them on the dearer tier, is
	// $12-22 against $19 net — so the tier is not underwater even for a reader
	// who uses all of it, which is the property the 150 did not have.
	paid: 25,
} as const;

/**
 * What Free is, as a fraction of Paid. Free is derived so that raising Paid
 * cannot quietly make the free tier generous, and lowering Paid cannot quietly
 * strangle it.
 */
export const FREE_SHARE_OF_PAID = 3 / 25;

/** The settings row the live Paid allowance is read from. */
export const PAID_TURNS_PER_WEEK_KEY = 'paid_turns_per_week';

/**
 * Whether a plan opens the scan of a cited page. One page at a time, and only
 * a page the reader's own citations point at; the whole file is the admin's.
 */
export const PAGE_SCANS = { free: false, paid: true } as const;
