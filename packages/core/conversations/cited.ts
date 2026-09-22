/// <reference types="@cloudflare/workers-types" />

/**
 * How far from a cited page a reader may look. A quote can run across the
 * break onto the next page, and the citation drawer shows the page either
 * side of the one cited, so one page each way is what reading a citation
 * takes and no more.
 */
export const CITED_PAGE_REACH = 1;

/**
 * Whether every page from `from` to `to` lies within reach of a page that a
 * citation in one of this reader's own conversations points at.
 *
 * This is what stands between a reader and the library itself. A route that
 * serves any page on request serves the whole book to a loop that asks for
 * pages 1 to 400; tying each page to a citation the reader was given means
 * the pages they can read are the pages they spent questions on.
 */
export async function isCitedForReader(
	db: D1Database,
	userId: string,
	documentId: string,
	from: number,
	to: number
): Promise<boolean> {
	const { results } = await db
		.prepare(
			`SELECT DISTINCT c.page_no AS page_no
			   FROM citations c
			   JOIN messages m ON m.id = c.message_id
			   JOIN conversations v ON v.id = m.conversation_id
			  WHERE v.user_id = ?
			    AND c.document_id = ?
			    AND c.page_no BETWEEN ? AND ?`
		)
		.bind(
			userId,
			documentId,
			from - CITED_PAGE_REACH,
			to + CITED_PAGE_REACH
		)
		.all<{ page_no: number }>();

	const cited = (results ?? []).map((row) => row.page_no);
	for (let page = from; page <= to; page++) {
		if (!cited.some((at) => Math.abs(at - page) <= CITED_PAGE_REACH)) {
			return false;
		}
	}
	return true;
}
