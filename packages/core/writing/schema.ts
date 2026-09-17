import { z } from 'zod';
import { MAX_LENGTHS } from '../platform/limits.js';

// =============================================================================
// Denormalized Row Schemas (new columnar tables)
// =============================================================================

const MediaKind = z.enum([
	'video',
	'movie',
	'tv',
	'game',
	'book',
	'podcast',
	'song',
	'article',
]);

// Shared free-text attribution fields (used by Notes and Quotes)
const Attribution = {
	creator: z.string().max(MAX_LENGTHS.TITLE).optional(),
	work: z.string().max(MAX_LENGTHS.TITLE).optional(),
	kind: MediaKind.optional(),
};

// --- Notes ---
export const NoteRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	content: z.string().min(1).max(MAX_LENGTHS.CONTENT),
	...Attribution,
	book_id: z.string().max(MAX_LENGTHS.ID).optional(),
	page: z.string().max(MAX_LENGTHS.SHORT).optional(),
	posted: z.number().int().min(0).max(1).default(0),
	tags: z.string().max(MAX_LENGTHS.TAGS).optional(), // JSON array string
	replaces: z.string().max(MAX_LENGTHS.ID).optional(),
	source: z.string().max(MAX_LENGTHS.SHORT).default('web'),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
	/** When the note was last dealt by shuffle mode. NULL = never surfaced. */
	last_surfaced_at: z.string().datetime().nullable().optional(),
});
export type NoteRow = z.infer<typeof NoteRow>;

/** A physical note row projected as the current version of one logical note. */
export const NoteView = NoteRow.extend({
	version: z.number().int().min(1),
	originalCreatedAt: z.string().datetime(),
});
export type NoteView = z.infer<typeof NoteView>;

export const NoteInput = NoteRow.omit({
	id: true,
	created_at: true,
	updated_at: true,
	last_surfaced_at: true,
}).extend({ id: z.string().optional() });
export type NoteInput = z.infer<typeof NoteInput>;

export const NotePatch = NoteInput.omit({ id: true }).partial();
export type NotePatch = z.infer<typeof NotePatch>;

// --- Quotes ---
export const QuoteRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	quote: z.string().min(1).max(MAX_LENGTHS.CONTENT),
	...Attribution,
	book_id: z.string().max(MAX_LENGTHS.ID).optional(),
	page: z.string().max(MAX_LENGTHS.SHORT).optional(),
	posted: z.number().int().min(0).max(1).default(0),
	tags: z.string().max(MAX_LENGTHS.TAGS).optional(),
	// Deprecated. The `replaces` column is retained on the `quotes` table for
	// historical rows produced by the old "edit = new version" flow, but new
	// quotes never set it and edits PATCH the row in place.
	replaces: z.string().max(MAX_LENGTHS.ID).optional(),
	source: z.string().max(MAX_LENGTHS.SHORT).default('web'),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type QuoteRow = z.infer<typeof QuoteRow>;

export const QuoteInput = QuoteRow.omit({
	id: true,
	replaces: true,
	created_at: true,
	updated_at: true,
}).extend({ id: z.string().optional() });
export type QuoteInput = z.infer<typeof QuoteInput>;

export const QuotePatch = QuoteInput.omit({ id: true }).partial();
export type QuotePatch = z.infer<typeof QuotePatch>;

// --- Media ---
export const MediaRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	title: z.string().max(MAX_LENGTHS.TITLE).optional(),
	url: z.string().max(MAX_LENGTHS.URL).optional(),
	kind: MediaKind,
	creator: z.string().max(MAX_LENGTHS.TITLE).optional(),
	note: z.string().max(MAX_LENGTHS.CONTENT).optional(),
	posted: z.number().int().min(0).max(1).default(0),
	tags: z.string().max(MAX_LENGTHS.TAGS).optional(),
	source: z.string().max(MAX_LENGTHS.SHORT).default('web'),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type MediaRow = z.infer<typeof MediaRow>;

export const MediaInput = MediaRow.omit({
	id: true,
	created_at: true,
	updated_at: true,
}).extend({ id: z.string().optional() });
export type MediaInput = z.infer<typeof MediaInput>;

export const MediaPatch = MediaInput.omit({ id: true }).partial();
export type MediaPatch = z.infer<typeof MediaPatch>;

// --- Links ---
export const LinkRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	title: z.string().max(MAX_LENGTHS.TITLE).optional(),
	url: z.string().min(1).max(MAX_LENGTHS.URL),
	site: z.string().max(MAX_LENGTHS.TITLE).optional(),
	og_title: z.string().max(MAX_LENGTHS.TITLE).optional(),
	note: z.string().max(MAX_LENGTHS.CONTENT).optional(),
	posted: z.number().int().min(0).max(1).default(0),
	tags: z.string().max(MAX_LENGTHS.TAGS).optional(),
	source: z.string().max(MAX_LENGTHS.SHORT).default('web'),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type LinkRow = z.infer<typeof LinkRow>;

export const LinkInput = LinkRow.omit({
	id: true,
	created_at: true,
	updated_at: true,
}).extend({ id: z.string().optional() });
export type LinkInput = z.infer<typeof LinkInput>;

export const LinkPatch = LinkInput.omit({ id: true }).partial();
export type LinkPatch = z.infer<typeof LinkPatch>;

// --- Sleep ---
export const SleepRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	hours: z.number().min(0).max(24),
	quality: z.number().int().min(0).max(10).optional(),
	bed_time: z.string().max(MAX_LENGTHS.SHORT).optional(),
	wake_time: z.string().max(MAX_LENGTHS.SHORT).optional(),
	note: z.string().max(MAX_LENGTHS.CONTENT).optional(),
	tags: z.string().max(MAX_LENGTHS.TAGS).optional(),
	source: z.string().max(MAX_LENGTHS.SHORT).default('web'),
	created_at: z.string().datetime(),
});
export type SleepRow = z.infer<typeof SleepRow>;

export const SleepInput = SleepRow.omit({
	id: true,
	created_at: true,
}).extend({ id: z.string().optional() });
export type SleepInput = z.infer<typeof SleepInput>;

// =============================================================================
// Connections (polymorphic edges)
// =============================================================================

export const EntityType = z.enum([
	'author',
	'book',
	'essay',
	'media',
	'note',
	'quote',
	'thought',
]);
export type EntityType = z.infer<typeof EntityType>;

export const ConnectionRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	a_type: EntityType,
	a_id: z.string().min(1).max(MAX_LENGTHS.ID),
	b_type: EntityType,
	b_id: z.string().min(1).max(MAX_LENGTHS.ID),
	metadata: z.string().max(MAX_LENGTHS.CONTENT).optional(), // JSON string
	created_at: z.string().datetime(),
});
export type ConnectionRow = z.infer<typeof ConnectionRow>;

export const ConnectionInput = ConnectionRow.omit({
	id: true,
	created_at: true,
}).extend({ id: z.string().optional() });
export type ConnectionInput = z.infer<typeof ConnectionInput>;

// =============================================================================
// Essays
// =============================================================================

export const EssayRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	content: z.string().min(1).max(MAX_LENGTHS.ESSAY),
	posted: z.number().int().min(0).max(1).default(0),
	tags: z.string().max(MAX_LENGTHS.TAGS).optional(),
	replaces: z.string().max(MAX_LENGTHS.ID).optional(),
	source: z.string().max(MAX_LENGTHS.SHORT).default('web'),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type EssayRow = z.infer<typeof EssayRow>;

export const EssayInput = EssayRow.omit({
	id: true,
	created_at: true,
	updated_at: true,
}).extend({ id: z.string().optional() });
export type EssayInput = z.infer<typeof EssayInput>;

export const EssayPatch = EssayInput.omit({ id: true }).partial();
export type EssayPatch = z.infer<typeof EssayPatch>;

export const EssayEntityType = z.enum(['book', 'quote', 'book_cover', 'image']);
export type EssayEntityType = z.infer<typeof EssayEntityType>;

// --- Essay Images ---
// Inline image embeds. Referenced from essay content via [[image:UUID]]
// tokens; materialised as essay_references rows with entity_type='image'.
// Owned by user, not essay — the same image may be embedded across essays.
export const EssayImageRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	user_id: z.string().min(1).max(MAX_LENGTHS.ID),
	path: z.string().min(1).max(MAX_LENGTHS.URL),
	mime_type: z.string().max(MAX_LENGTHS.SHORT).optional(),
	caption: z.string().max(MAX_LENGTHS.TITLE).optional(),
	source_url: z.string().max(MAX_LENGTHS.URL).optional(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type EssayImageRow = z.infer<typeof EssayImageRow>;

export const EssayImageInput = EssayImageRow.omit({
	id: true,
	user_id: true,
	created_at: true,
	updated_at: true,
}).extend({ id: z.string().optional() });
export type EssayImageInput = z.infer<typeof EssayImageInput>;

export const EssayImagePatch = z
	.object({
		caption: z.string().max(MAX_LENGTHS.TITLE).nullable().optional(),
		source_url: z.string().max(MAX_LENGTHS.URL).nullable().optional(),
	})
	.partial();
export type EssayImagePatch = z.infer<typeof EssayImagePatch>;

export const EssayReferenceRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	essay_id: z.string().min(1).max(MAX_LENGTHS.ID),
	entity_type: EssayEntityType,
	entity_id: z.string().min(1).max(MAX_LENGTHS.ID),
	page: z.string().max(MAX_LENGTHS.SHORT).optional(),
	position: z.number().int().min(0).default(0),
	params: z.record(z.union([z.string(), z.number()])).optional(),
});
export type EssayReferenceRow = z.infer<typeof EssayReferenceRow>;

export const EssayReferenceInput = z.object({
	entity_type: EssayEntityType,
	entity_id: z.string().min(1).max(MAX_LENGTHS.ID),
	page: z.string().max(MAX_LENGTHS.SHORT).nullable().optional(),
	position: z.number().int().min(0).optional(),
	params: z.record(z.union([z.string(), z.number()])).optional(),
});
export type EssayReferenceInput = z.infer<typeof EssayReferenceInput>;

// =============================================================================
// Threads (named ordered collections)
// =============================================================================

export const ThreadRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	name: z.string().min(1).max(MAX_LENGTHS.TITLE),
	description: z.string().max(MAX_LENGTHS.CONTENT).optional(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type ThreadRow = z.infer<typeof ThreadRow>;

export const ThreadInput = ThreadRow.omit({
	id: true,
	created_at: true,
	updated_at: true,
}).extend({ id: z.string().optional() });
export type ThreadInput = z.infer<typeof ThreadInput>;

export const ThreadPatch = ThreadInput.omit({ id: true }).partial();
export type ThreadPatch = z.infer<typeof ThreadPatch>;

export const ThreadItemRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	thread_id: z.string().min(1).max(MAX_LENGTHS.ID),
	entity_type: z.string().min(1).max(MAX_LENGTHS.SHORT),
	entity_id: z.string().min(1).max(MAX_LENGTHS.ID),
	position: z.number().int().min(0),
	added_at: z.string().datetime(),
});
export type ThreadItemRow = z.infer<typeof ThreadItemRow>;

export const ThreadItemInput = ThreadItemRow.omit({
	id: true,
	added_at: true,
	position: true,
}).extend({ id: z.string().optional() });
export type ThreadItemInput = z.infer<typeof ThreadItemInput>;

export const ReorderItem = z.object({
	entity_type: z.string().min(1).max(MAX_LENGTHS.SHORT),
	entity_id: z.string().min(1).max(MAX_LENGTHS.ID),
	position: z.number().int().min(0),
});
export type ReorderItem = z.infer<typeof ReorderItem>;

// =============================================================================
// Thoughts
// =============================================================================

export const ThoughtRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	content: z.string().min(1).max(MAX_LENGTHS.CONTENT),
	author: z.string().max(MAX_LENGTHS.SHORT).default('web'),
	created_at: z.string().datetime(),
	x: z.number().optional(),
	y: z.number().optional(),
	mood_score: z.number().int().min(1).max(10).optional(),
	mood_tags: z.string().max(MAX_LENGTHS.TAGS).optional(), // JSON array string
});
export type ThoughtRow = z.infer<typeof ThoughtRow>;

export const ThoughtInput = z.object({
	content: z.string().min(1).max(MAX_LENGTHS.CONTENT),
	author: z.string().max(MAX_LENGTHS.SHORT).optional(),
	created_at: z.string().datetime().optional(),
	mood_score: z.number().int().min(1).max(10).optional(),
	mood_tags: z.array(z.string().max(MAX_LENGTHS.SHORT)).optional(),
});
export type ThoughtInput = z.infer<typeof ThoughtInput>;

export const ThoughtPatch = z.object({
	content: z.string().min(1).max(MAX_LENGTHS.CONTENT).optional(),
	mood_score: z.number().int().min(1).max(10).nullable().optional(),
	mood_tags: z.array(z.string().max(MAX_LENGTHS.SHORT)).nullable().optional(),
});
export type ThoughtPatch = z.infer<typeof ThoughtPatch>;
