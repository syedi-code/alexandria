import { describe, it, expect } from 'vitest';
import router from '../api/router.js';

/**
 * Hono matches in registration order, so the route table is part of the
 * contract, not an implementation detail: /books/library has to be registered
 * before /books/:id or the parameter swallows it. This records both the set of
 * routes and their order.
 */
const table = router.routes
	.filter((r) => r.method !== 'ALL')
	.map((r) => `${r.method} ${r.path}`);

describe('the API surface', () => {
	it('is unchanged by the module split', () => {
		expect(table).toMatchSnapshot();
	});

	it('registers /books/library ahead of /books/:id', () => {
		expect(table.indexOf('GET /books/library')).toBeGreaterThan(-1);
		expect(table.indexOf('GET /books/library')).toBeLessThan(
			table.indexOf('GET /books/:id')
		);
	});

	it('registers /books/:id/detail ahead of /books/:id', () => {
		expect(table.indexOf('GET /books/:id/detail')).toBeLessThan(
			table.indexOf('GET /books/:id')
		);
	});

	it('registers the media routes ahead of /books/:id', () => {
		expect(table.indexOf('GET /books/:id/media')).toBeLessThan(
			table.indexOf('GET /books/:id')
		);
	});

	it('registers /mcp ahead of the session middleware, which would demand a browser session', () => {
		const all = router.routes.map((r) => `${r.method} ${r.path}`);
		expect(all.indexOf('ALL /mcp')).toBeGreaterThan(-1);
		expect(all.indexOf('ALL /mcp')).toBeLessThan(all.indexOf('ALL /*'));
	});

	it('registers POST /session ahead of the session middleware', () => {
		const all = router.routes.map((r) => `${r.method} ${r.path}`);
		expect(all.indexOf('POST /session')).toBeLessThan(
			all.indexOf('ALL /*')
		);
	});
});
