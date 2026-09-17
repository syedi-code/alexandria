import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import { tool } from 'ai';
import { z } from 'zod';
import {
	isOmittedToolOutput,
	type OmittedToolOutput,
	type PageHandles,
} from '@alexandria/core/conversations';
import {
	describePage,
	isViewable,
	renderPages,
	renderSearchHits,
	viewPage,
	worksTools,
	type PageRef,
	type PageText,
	type PageView,
	type ReadPagesInput,
	type SearchHit,
	type SearchInput,
	type WorksToolContext,
} from '@alexandria/core/works';
import type { ModelEntry } from './models.js';

/** Tools whose results carry page text, and so get dropped from old turns. */
export const PAGE_TOOLS = ['search_pages', 'read_pages', 'view_page'] as const;

type Labelled<T> = T & { handle: string };

const heading = (page: Labelled<Parameters<typeof describePage>[0]>) =>
	`[${page.handle}] ${describePage(page)}`;

const asText = (value: string): ToolResultOutput => ({ type: 'text', value });

const omitted = ({ handles }: OmittedToolOutput) =>
	asText(
		handles.length
			? `[Earlier result omitted to save space. ${handles.join(', ')} can still be cited, or re-read with read_pages.]`
			: '[Earlier result omitted to save space.]'
	);

/** Renders a labelled result for the model, or the stub left once it has been omitted from history. */
const renderFor =
	<Item>(render: (items: Labelled<Item>[]) => string) =>
	({
		output,
	}: {
		output: Labelled<Item>[] | OmittedToolOutput;
	}): ToolResultOutput =>
		isOmittedToolOutput(output) ? omitted(output) : asText(render(output));

const unviewable = (handle: string, reason: string) =>
	asText(`${handle} cannot be viewed: ${reason}.`);

interface ViewResult {
	handle: string;
	ref: PageRef | null;
	/** Why the page cannot be shown; null when it can. */
	unavailable: string | null;
}

/**
 * The works tools as the chat agent sees them: pages are named by handle, and
 * results are rendered as readable text rather than JSON. verify_citation is
 * left out — the server verifies the whole answer, so the model can't skip it.
 */
export function chatTools(
	ctx: WorksToolContext,
	handles: PageHandles,
	model: Pick<ModelEntry, 'acceptsFiles'>
) {
	const views = new Map<string, Promise<PageView>>();
	const view = (ref: PageRef) => {
		const key = `${ref.document_id}#${ref.page_no}`;
		if (!views.has(key)) {
			views.set(
				key,
				viewPage({ DB: ctx.db, R2_BUCKET: ctx.bucket }, ref)
			);
		}
		return views.get(key)!;
	};

	const tools = {
		list_works: tool({
			description: worksTools.list_works.description,
			inputSchema: worksTools.list_works.input,
			execute: (input) => worksTools.list_works.run(ctx, input),
		}),

		search_pages: tool({
			description: worksTools.search_pages.description,
			inputSchema: worksTools.search_pages.input,
			execute: async (
				input: SearchInput
			): Promise<Labelled<SearchHit>[]> =>
				handles.label(await worksTools.search_pages.run(ctx, input)),
			toModelOutput: renderFor<SearchHit>((hits) =>
				renderSearchHits<Labelled<SearchHit>>(hits, heading)
			),
		}),

		read_pages: tool({
			description: worksTools.read_pages.description,
			inputSchema: worksTools.read_pages.input,
			execute: async (
				input: ReadPagesInput
			): Promise<Labelled<PageText>[]> =>
				handles.label(await worksTools.read_pages.run(ctx, input)),
			toModelOutput: renderFor<PageText>((pages) =>
				renderPages<Labelled<PageText>>(pages, heading)
			),
		}),
	};

	if (!model.acceptsFiles) return tools;

	return {
		...tools,
		view_page: tool({
			description: worksTools.view_page.description,
			inputSchema: z.object({
				page: z
					.string()
					.regex(/^P\d+$/)
					.describe(
						'A page handle, such as P7, from search_pages or read_pages'
					),
			}),
			execute: async ({ page }): Promise<ViewResult> => {
				const ref = handles.resolve(page) ?? null;
				if (!ref)
					return { handle: page, ref, unavailable: 'unknown_handle' };
				const result = await view(ref);
				return {
					handle: page,
					ref,
					unavailable: isViewable(result) ? null : result.reason,
				};
			},
			// Page bytes are fetched here rather than returned from execute, so they
			// reach the model without ever being stored in the conversation.
			toModelOutput: async ({ output }): Promise<ToolResultOutput> => {
				if (isOmittedToolOutput(output)) return omitted(output);
				if (output.unavailable)
					return unviewable(output.handle, output.unavailable);

				const result = await view(output.ref);
				if (!isViewable(result))
					return unviewable(output.handle, result.reason);
				return {
					type: 'content',
					value: [
						{ type: 'text', text: `[${output.handle}]` },
						{
							type: 'file',
							mediaType: result.media_type,
							data: { type: 'data', data: result.data },
						},
					],
				};
			},
		}),
	};
}
