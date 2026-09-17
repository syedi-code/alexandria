import { z } from 'zod';
import { MAX_LENGTHS } from '../platform/limits.js';

// =============================================================================
// Work — the core entity
// =============================================================================
// Anything a Note or Quote can attach to. `kind` says which; `book` is the
// only fully-modelled one so far.

export const WorkKind = z.enum([
	'book',
	'article',
	'lecture',
	'podcast',
	'film',
	'other',
]);
export type WorkKind = z.infer<typeof WorkKind>;

export const Work = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	kind: WorkKind.default('book'),
	title: z.string().min(1).max(MAX_LENGTHS.TITLE),
	creator: z.string().min(1).max(MAX_LENGTHS.TITLE),
	creator_id: z.string().max(MAX_LENGTHS.ID).nullable().optional(),
	originally_published: z
		.string()
		.max(MAX_LENGTHS.SHORT)
		.nullable()
		.optional(),
	isbn: z.string().max(MAX_LENGTHS.SHORT).nullable().optional(),
	description: z.string().max(MAX_LENGTHS.CONTENT).nullable().optional(),
	/** R2 object key, not a URL — resolved through /files/sign. */
	cover_key: z.string().max(MAX_LENGTHS.URL).nullable().optional(),
	primary_document_id: z.string().max(MAX_LENGTHS.ID).nullable().optional(),
	deleted_at: z.string().nullable().optional(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type Work = z.infer<typeof Work>;

export const WorkInput = Work.omit({
	id: true,
	deleted_at: true,
	created_at: true,
	updated_at: true,
}).extend({ id: z.string().optional() });
export type WorkInput = z.infer<typeof WorkInput>;

export const WorkPatch = WorkInput.omit({ id: true }).partial();
export type WorkPatch = z.infer<typeof WorkPatch>;

// =============================================================================
// Document — a concrete file a Work exists as
// =============================================================================
// Pagination belongs to the file, not the work: a translation has its own.

export const DocumentRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	work_id: z.string().min(1).max(MAX_LENGTHS.ID),
	r2_key: z.string().max(MAX_LENGTHS.URL).nullable().optional(),
	label: z.string().max(MAX_LENGTHS.TITLE).nullable().optional(),
	page_offset: z.number().int().default(0),
	page_count: z.number().int().nullable().optional(),
	is_primary: z.number().int().min(0).max(1).default(0),
	current_transcription_id: z
		.string()
		.max(MAX_LENGTHS.ID)
		.nullable()
		.optional(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type DocumentRow = z.infer<typeof DocumentRow>;

export const DocumentInput = DocumentRow.omit({
	id: true,
	work_id: true,
	current_transcription_id: true,
	created_at: true,
	updated_at: true,
}).extend({ id: z.string().optional() });
export type DocumentInput = z.infer<typeof DocumentInput>;

export const DocumentPatch = DocumentInput.omit({ id: true }).partial();
export type DocumentPatch = z.infer<typeof DocumentPatch>;

// =============================================================================
// Transcription — one extraction run over one document
// =============================================================================

export const TranscriptionStatus = z.enum([
	'pending',
	'running',
	'complete',
	'failed',
]);
export type TranscriptionStatus = z.infer<typeof TranscriptionStatus>;

export const TranscriptionRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	document_id: z.string().min(1).max(MAX_LENGTHS.ID),
	model: z.string().min(1).max(MAX_LENGTHS.SHORT),
	prompt_version: z.string().max(MAX_LENGTHS.SHORT).nullable().optional(),
	status: TranscriptionStatus.default('pending'),
	started_at: z.string().nullable().optional(),
	finished_at: z.string().nullable().optional(),
	cost: z.number().nullable().optional(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type TranscriptionRow = z.infer<typeof TranscriptionRow>;

export const PageRow = z.object({
	transcription_id: z.string().min(1).max(MAX_LENGTHS.ID),
	page_no: z.number().int().min(0),
	text: z.string().nullable().optional(),
	image_key: z.string().max(MAX_LENGTHS.URL).nullable().optional(),
});
export type PageRow = z.infer<typeof PageRow>;

// =============================================================================
// Book — the facade
// =============================================================================
// A Book is a Work whose kind is `book`, projected into the payload stylus
// has always received. Same field names, same types, sourced from works and
// its primary document. Plan D7.
export const Book = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	title: z.string().min(1).max(MAX_LENGTHS.TITLE),
	author: z.string().min(1).max(MAX_LENGTHS.TITLE),
	pdf_url: z.string().max(MAX_LENGTHS.URL).optional(),
	cover_url: z.string().max(MAX_LENGTHS.URL).optional(),
	isbn: z.string().max(MAX_LENGTHS.SHORT).optional(),
	description: z.string().max(MAX_LENGTHS.CONTENT).optional(),
	originally_published: z.string().max(MAX_LENGTHS.SHORT).optional(),
	pdf_page_offset: z.number().int().default(0), // Offset to calculate PDF page from print page
	author_id: z.string().max(MAX_LENGTHS.ID).optional(), // FK to authors table
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export type Book = z.infer<typeof Book>;

export const BookInput = Book.omit({
	id: true,
	created_at: true,
	updated_at: true,
}).extend({
	id: z.string().optional(),
});

export type BookInput = z.infer<typeof BookInput>;

export const BookPatch = BookInput.omit({ id: true }).partial();
export type BookPatch = z.infer<typeof BookPatch>;

// Creator — the person a Work is attributed to. `Author` is the facade name.
export const Creator = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	name: z.string().min(1).max(MAX_LENGTHS.TITLE),
	bio: z.string().max(MAX_LENGTHS.CONTENT).optional(),
	born: z.string().max(MAX_LENGTHS.SHORT).optional(),
	died: z.string().max(MAX_LENGTHS.SHORT).optional(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export type Creator = z.infer<typeof Creator>;

export const Author = Creator;
export type Author = Creator;

export const CreatorInput = Creator.omit({
	id: true,
	created_at: true,
	updated_at: true,
}).extend({
	id: z.string().optional(),
});

export type CreatorInput = z.infer<typeof CreatorInput>;

export const AuthorInput = CreatorInput;
export type AuthorInput = CreatorInput;

export const CreatorPatch = CreatorInput.omit({ id: true }).partial();
export type CreatorPatch = z.infer<typeof CreatorPatch>;

export const AuthorPatch = CreatorPatch;
export type AuthorPatch = CreatorPatch;

// Work media: any number of visual attachments per work.
// Distinct from works.cover_key, which is reserved for the essay book-cover
// slide kind. `BookMedia*` are the facade names; the table is work_media and
// its file column is r2_key.
export const WorkMediaKind = z.enum(['image']);
export const WorkMediaRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	work_id: z.string().min(1).max(MAX_LENGTHS.ID),
	r2_key: z.string().min(1).max(MAX_LENGTHS.URL),
	kind: WorkMediaKind.default('image'),
	caption: z.string().max(MAX_LENGTHS.TITLE).optional(),
	sort_order: z.number().int().default(0),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type WorkMediaRow = z.infer<typeof WorkMediaRow>;

export const WorkMediaInput = WorkMediaRow.omit({
	id: true,
	work_id: true,
	created_at: true,
	updated_at: true,
}).extend({ id: z.string().optional() });
export type WorkMediaInput = z.infer<typeof WorkMediaInput>;

export const WorkMediaPatch = z
	.object({
		caption: z.string().max(MAX_LENGTHS.TITLE).optional(),
		sort_order: z.number().int().optional(),
	})
	.partial();
export type WorkMediaPatch = z.infer<typeof WorkMediaPatch>;

export const BookMediaKind = WorkMediaKind;
export const BookMediaRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	book_id: z.string().min(1).max(MAX_LENGTHS.ID),
	path: z.string().min(1).max(MAX_LENGTHS.URL),
	kind: BookMediaKind.default('image'),
	caption: z.string().max(MAX_LENGTHS.TITLE).optional(),
	sort_order: z.number().int().default(0),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type BookMediaRow = z.infer<typeof BookMediaRow>;

export const BookMediaInput = BookMediaRow.omit({
	id: true,
	book_id: true,
	created_at: true,
	updated_at: true,
}).extend({ id: z.string().optional() });
export type BookMediaInput = z.infer<typeof BookMediaInput>;

export const BookMediaPatch = z
	.object({
		caption: z.string().max(MAX_LENGTHS.TITLE).optional(),
		sort_order: z.number().int().optional(),
	})
	.partial();
export type BookMediaPatch = z.infer<typeof BookMediaPatch>;
