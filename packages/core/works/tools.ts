/// <reference types="@cloudflare/workers-types" />
import { z } from 'zod';
import { verifyCitation, type CitationCheck } from './citations.js';
import { ToolUnavailableError } from './tool-errors.js';
import {
	listReadableWorks,
	MAX_READABLE_WORKS_LIMIT,
	type ReadableWorksInput,
	type WorkSummary,
} from './reading.js';
import { viewPage, type PageView } from './page-view.js';
import {
	MAX_PAGES_PER_READ,
	readPages,
	type PageRef,
	type PageText,
	type ReadPagesInput,
} from './pages.js';
import {
	MAX_SEARCH_LIMIT,
	searchPages,
	type SearchHit,
	type SearchInput,
} from './search.js';

/**
 * The library as tools a model can use: one definition per tool, adapted by the
 * chat agent and the MCP server. Descriptions are written for the model.
 */

export interface WorksToolContext {
	db: D1Database;
	search?: D1Database;
	bucket?: R2Bucket;
}

export interface WorksTool<Input, Output> {
	description: string;
	/** Validates input at runtime. With strictNullChecks off its inferred type makes every field optional, so `run` declares its own. */
	input: z.AnyZodObject;
	run(ctx: WorksToolContext, input: Input): Promise<Output>;
}

const defineTool = <Input, Output>(tool: WorksTool<Input, Output>) => tool;

const documentId = z
	.string()
	.min(1)
	.max(100)
	.describe('Document id, from list_works or search_pages');
const pageNo = z
	.number()
	.int()
	.min(1)
	.describe('1-based PDF page index — not the printed page number');

export const worksTools = {
	list_works: defineTool({
		description:
			'List works in the library with their documents (a work can exist as several editions or translations). Use it to find out what the library holds before searching. A document whose text is "scan" cannot be searched; read it with view_page.',
		input: z.object({
			filter: z
				.string()
				.max(200)
				.optional()
				.describe('Matches title or creator'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(MAX_READABLE_WORKS_LIMIT)
				.optional(),
		}),
		run: (ctx, input: ReadableWorksInput): Promise<WorkSummary[]> =>
			listReadableWorks(ctx.db, input),
	}),

	search_pages: defineTool({
		description:
			'Keyword search across the text of every page in the library. Returns pages with a short snippet around the match. Search for the exact terms a text would use — terms of art, names, distinctive phrases in "quotes" — and search again with different words if the first results miss. Snippets are too short to quote from; read the page.',
		input: z.object({
			query: z.string().min(1).max(500),
			work_ids: z.array(z.string().max(100)).max(20).optional(),
			document_ids: z.array(z.string().max(100)).max(20).optional(),
			limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
		}),
		run: async (ctx, input: SearchInput): Promise<SearchHit[]> => {
			if (!ctx.search) {
				throw new ToolUnavailableError(
					'Page search is not configured.'
				);
			}
			return searchPages(ctx.search, ctx.db, input);
		},
	}),

	read_pages: defineTool({
		description: `Read the full text of up to ${MAX_PAGES_PER_READ} consecutive pages of one document. Read the pages around a passage before characterising an argument; arguments rarely fit on one page.`,
		input: z.object({
			document_id: documentId,
			from: pageNo,
			to: pageNo.optional(),
		}),
		run: (ctx, input: ReadPagesInput): Promise<PageText[]> =>
			readPages(ctx.db, input),
	}),

	view_page: defineTool({
		description:
			'See one page as it looks on paper. Use it for scanned documents, Greek or other scripts, footnotes, tables, or when extracted text looks garbled.',
		input: z.object({ document_id: documentId, page_no: pageNo }),
		run: (ctx, ref: PageRef): Promise<PageView> =>
			viewPage({ DB: ctx.db, R2_BUCKET: ctx.bucket }, ref),
	}),

	verify_citation: defineTool({
		description:
			'Check that a quote really appears on a page (or runs from it onto the next). Call it for every quote before presenting it.',
		input: z.object({
			document_id: documentId,
			page_no: pageNo,
			quote: z.string().min(1).max(2000),
		}),
		run: (
			ctx,
			{ quote, ...ref }: PageRef & { quote: string }
		): Promise<CitationCheck> => verifyCitation(ctx.db, { ref, quote }),
	}),
};

export type WorksToolName = keyof typeof worksTools;

/**
 * How any model should work with these tools. Each front door adds its own
 * citation syntax.
 */
export const READING_PRACTICE = [
	'Answer from the texts in the library, not from memory. When the library does not address a question, say so plainly.',
	'Find passages with search_pages, then read_pages around them before characterising an argument. Search again with the vocabulary the text itself uses when a first search misses.',
	'Every claim about what a text says carries a citation with a verbatim quote of at least five words, copied exactly from a page you have read.',
	'Keep what a text says separate from your own interpretation of it, and mark interpretation as yours.',
	'Translations differ. When wording matters, say which work and edition you are quoting.',
] as const;

/** Pages as the model reads them: a heading naming each page, then its text. */
export function renderPages<Page extends PageText>(
	pages: readonly Page[],
	heading: (page: Page) => string
): string {
	if (pages.length === 0) return 'No such pages.';
	return pages
		.map(
			(page) =>
				`${heading(page)}\n${page.text ?? '[This page has no text layer. Use view_page to see it.]'}`
		)
		.join('\n\n---\n\n');
}

export function renderSearchHits<Hit extends SearchHit>(
	hits: readonly Hit[],
	heading: (hit: Hit) => string
): string {
	if (hits.length === 0) return 'No pages matched.';
	return hits.map((hit) => `${heading(hit)}\n${hit.snippet}`).join('\n\n');
}
