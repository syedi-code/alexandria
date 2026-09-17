import { Hono } from 'hono';
import type { Env, AuthContext } from '@alexandria/core';
import { getUserById } from '@alexandria/core';

const debugRouter = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

/**
 * GET /auth/debug
 *
 * Returns live auth diagnostics from inside the Worker.
 * Requires a valid session (sessionMiddleware runs globally before this route).
 *
 * Does NOT expose secret values — only reports presence/absence of env vars.
 */
debugRouter.get('/', async (c) => {
	const authContext = c.get('authContext');
	if (!authContext) {
		return c.json({ error: 'Authentication required' }, 401);
	}

	let userRecordExists = false;
	if (c.env.DB && authContext.user.id) {
		try {
			const record = await getUserById(c.env.DB, authContext.user.id);
			userRecordExists = record !== null;
		} catch {
			// Non-fatal — DB lookup failure doesn't break diagnostics
		}
	}

	return c.json({
		authenticated: true,
		user: authContext.user,
		role: authContext.role,
		authMethod: 'session',
		diagnostics: {
			userRecordExists,
			envVarsPresent: {
				TEAM_DOMAIN: !!c.env.TEAM_DOMAIN,
				POLICY_AUD: !!c.env.POLICY_AUD,
				ADMIN_EMAIL: !!c.env.ADMIN_EMAIL,
				DB: !!c.env.DB,
			},
		},
		timestamp: new Date().toISOString(),
	});
});

export default debugRouter;
