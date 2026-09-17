import { Hono } from 'hono';
import { cors } from 'hono/cors';
import apiRouter from './api/router.js';
import { Env } from '@alexandria/core';

const app = new Hono<{ Bindings: Env }>();

// CORS for all /api routes - must be before other middleware
app.use(
	'/api/*',
	cors({
		origin: (origin) => {
			// Both frontends reach alexandria same-origin through their own
			// Pages Function proxy, so CORS only matters for direct access
			// to the worker's own hostnames.
			const allowed = [
				'https://stylus.socialeating.studio',
				'https://scribe.socialeating.studio',
				'https://anti.socialeating.studio',
				'https://journal.ibrahimsyed.io',
				'https://antisocial-media.pages.dev',
				'https://staging.antisocial-media.pages.dev',
				'http://localhost:4571',
				'http://localhost:5173',
			];
			return allowed.includes(origin) ? origin : null;
		},
		allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
		allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
		credentials: true,
	})
);

// Security headers for all /api routes
app.use('/api/*', async (c, next) => {
	await next();
	c.header('X-Content-Type-Options', 'nosniff');
	c.header('X-Frame-Options', 'DENY');
	c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});

// Handle OPTIONS preflight explicitly (bypass auth) - let CORS middleware handle headers
app.options('/api/*', (c) => c.body(null, 204));

// Health check
app.get('/health', (c) => c.json({ ok: true }));

// Mount routers
app.route('/api', apiRouter);

export default {
	fetch: app.fetch,
};
