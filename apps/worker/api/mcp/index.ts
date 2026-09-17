import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Env } from '@alexandria/core/platform';
import { serviceTokenAuth } from './auth.js';
import { createAlexandriaMcp } from './server.js';

/**
 * Mounted ahead of the session middleware: MCP clients authenticate with an
 * Access service token, not a browser session. Stateless — each request gets a
 * fresh server, so nothing is held between calls.
 */
const app = new Hono<{ Bindings: Env }>();

app.all('/mcp', serviceTokenAuth(), async (c) => {
	const server = createAlexandriaMcp({
		db: c.env.DB,
		search: c.env.SEARCH,
		bucket: c.env.R2_BUCKET,
	});
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	return transport.handleRequest(c.req.raw);
});

export default app;
