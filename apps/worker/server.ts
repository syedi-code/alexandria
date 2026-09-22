import { Hono } from 'hono';
import { cors } from 'hono/cors';
import apiRouter from './api/router.js';
import { Env } from '@alexandria/core';
import {
	cleanupExpiredSessions,
	EXPIRED_SESSION_RETENTION_DAYS,
} from '@alexandria/core/platform';
import { pruneConversations } from '@alexandria/core/conversations';

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
	c.header(
		'Strict-Transport-Security',
		'max-age=31536000; includeSubDomains'
	);
});

// Handle OPTIONS preflight explicitly (bypass auth) - let CORS middleware handle headers
app.options('/api/*', (c) => c.body(null, 204));

// Health check
app.get('/health', (c) => c.json({ ok: true }));

// Mount routers
app.route('/api', apiRouter);

export default {
	fetch: app.fetch,

	// The daily cron in wrangler.toml. D1 has no TTL, and a cleanup fired from a
	// request without waitUntil is cancelled when the response is sent, which is
	// how 394 expired sessions accumulated.
	//
	// Each job runs whether or not the one before it failed: a session table
	// that will not prune is no reason to keep conversations past the 30 days
	// the privacy page promises.
	async scheduled(_controller: ScheduledController, env: Env) {
		const jobs = [
			[
				'expired sessions',
				() =>
					cleanupExpiredSessions(
						env.DB,
						EXPIRED_SESSION_RETENTION_DAYS
					),
			],
			[
				'conversations past 30 days, or deleted',
				() =>
					pruneConversations(env.DB, {
						spare: env.ADMIN_EMAIL ?? null,
					}),
			],
		] as const;
		for (const [what, job] of jobs) {
			try {
				console.log(`[cron] removed ${await job()} ${what}`);
			} catch (error) {
				console.error(`[cron] ${what} failed`, error);
			}
		}
	},
};
