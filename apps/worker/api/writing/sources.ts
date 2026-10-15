/**
 * A list carries each row's book and author only when asked: the 500-row
 * catalogues stylus loads for its pickers never show them, and would spend
 * CPU the free tier does not have.
 */
export const includesSources = (c: {
	req: { query: (key: string) => string | undefined };
}): boolean => c.req.query('include') === 'sources';
