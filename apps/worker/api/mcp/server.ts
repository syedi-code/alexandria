import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
	describePage,
	isViewable,
	READING_PRACTICE,
	renderPages,
	renderSearchHits,
	ToolUnavailableError,
	worksTools,
	type PageRef,
	type PageView,
	type WorksToolContext,
	type WorksToolName,
} from '@alexandria/core/works';

const INSTRUCTIONS = [
	'Alexandria is a library of books, held as PDFs and searchable page by page.',
	...READING_PRACTICE,
	'Cite as: work, p. <printed page> (PDF p. <page_no>), "verbatim quote". Call verify_citation for every quote before presenting it; if it fails, re-read the page and correct the quote or drop the claim.',
].join('\n\n');

const locate = (page: Parameters<typeof describePage>[0]) =>
	`${describePage(page)} [document_id ${page.ref.document_id}, page_no ${page.ref.page_no}]`;

const text = (value: string): CallToolResult => ({
	content: [{ type: 'text', text: value }],
});

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function presentPageView(view: PageView, ref: PageRef): CallToolResult {
	if (!isViewable(view)) {
		return {
			isError: true,
			...text(`This page cannot be viewed: ${view.reason}.`),
		};
	}
	const data = toBase64(view.data);
	if (view.media_type.startsWith('image/')) {
		return {
			content: [{ type: 'image', data, mimeType: view.media_type }],
		};
	}
	return {
		content: [
			{
				type: 'resource',
				resource: {
					uri: `alexandria://documents/${ref.document_id}/pages/${ref.page_no}`,
					mimeType: view.media_type,
					blob: data,
				},
			},
		],
	};
}

type Output<Name extends WorksToolName> = Awaited<
	ReturnType<(typeof worksTools)[Name]['run']>
>;

const present: {
	[Name in WorksToolName]: (
		output: Output<Name>,
		input: never
	) => CallToolResult;
} = {
	list_works: (works) => text(JSON.stringify(works, null, 2)),
	search_pages: (hits) => text(renderSearchHits(hits, locate)),
	read_pages: (pages) => text(renderPages(pages, locate)),
	view_page: (view, ref: PageRef) => presentPageView(view, ref),
	verify_citation: (check) => text(JSON.stringify(check)),
};

export function createAlexandriaMcp(ctx: WorksToolContext): McpServer {
	const server = new McpServer(
		{ name: 'alexandria', version: '1.0.0' },
		{ instructions: INSTRUCTIONS }
	);

	for (const name of Object.keys(worksTools) as WorksToolName[]) {
		const tool = worksTools[name];
		server.registerTool(
			name,
			{
				description: tool.description,
				inputSchema: tool.input.shape,
				annotations: { readOnlyHint: true },
			},
			async (input: never) => {
				try {
					const output = await tool.run(ctx, input);
					return present[name](output as never, input);
				} catch (error) {
					if (error instanceof ToolUnavailableError) {
						return { isError: true, ...text(error.message) };
					}
					throw error;
				}
			}
		);
	}

	return server;
}
