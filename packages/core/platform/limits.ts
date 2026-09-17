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
