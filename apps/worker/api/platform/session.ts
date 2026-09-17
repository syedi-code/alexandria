import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env, AuthContext } from '@alexandria/core';
import {
	createSession,
	getSessionByToken,
	upsertUser,
	cleanupExpiredSessions,
	getUserById,
	sessionDurationHours,
} from '@alexandria/core/platform';
import { populateWelcomeData } from '@alexandria/core/writing';
import { apiContract } from '@alexandria/core';
import {
	isLocalDev,
	localDevIdentity,
	verifyJwtAndGetIdentity,
} from '../auth.js';

/**
 * Two routers, not one: POST /session must be mounted before the session
 * middleware so it can mint a session without already having one, and GET /me
 * must be mounted after it so authContext is populated. router.ts does both.
 */
export const sessionRoutes = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

export const identityRoutes = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// POST /api/session — create or validate a session
// Registered BEFORE the global sessionMiddleware so it bypasses session auth.
sessionRoutes.post('/session', async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	// If the user already has a valid session cookie, return it
	const existingToken = getCookie(c, '__session');
	if (existingToken) {
		const existing = await getSessionByToken(db, existingToken);
		if (existing) {
			return c.json(
				{
					user: { id: existing.user_id, email: existing.email },
					role: existing.role,
					contract: apiContract(),
				},
				200
			);
		}
	}

	// Local dev: stand in for Access, which is not in front of a local process.
	if (isLocalDev(c)) {
		const { user, role } = localDevIdentity(c.env);
		return c.json({ user, role, contract: apiContract() }, 200);
	}

	// Verify CF Access JWT (one-time)
	const jwtToken = c.req.header('cf-access-jwt-assertion');
	if (!jwtToken) {
		return c.json(
			{
				error: 'Invalid or expired CF Access token',
				code: 'JWT_VERIFICATION_FAILED',
			},
			401
		);
	}

	try {
		const { sub, email } = await verifyJwtAndGetIdentity(c.env, jwtToken);
		const role = email === c.env.ADMIN_EMAIL ? 'admin' : 'member';

		// Upsert user record
		try {
			await upsertUser(db, { id: sub, email });
		} catch (dbErr) {
			console.error('[Session] upsertUser failed:', dbErr);
		}

		// Populate welcome data for first-time users
		await populateWelcomeData(db, sub);

		// Create session
		const durationHours = sessionDurationHours(
			c.env.SESSION_DURATION_HOURS
		);
		const session = await createSession(db, {
			userId: sub,
			email,
			role,
			durationHours,
		});

		// Opportunistically clean up expired sessions
		cleanupExpiredSessions(db).catch(() => {});

		// Set session cookie
		setCookie(c, '__session', session.token, {
			path: '/api',
			httpOnly: true,
			secure: !isLocalDev(c),
			sameSite: 'Lax',
			maxAge: durationHours * 60 * 60,
		});

		return c.json(
			{
				user: { id: sub, email },
				role,
				contract: apiContract(),
			},
			201
		);
	} catch (err) {
		console.error('[Session] JWT verification failed:', err);
		return c.json(
			{
				error: 'Invalid or expired CF Access token',
				code: 'JWT_VERIFICATION_FAILED',
			},
			401
		);
	}
});

// GET /me — return authenticated user identity and role
identityRoutes.get('/me', async (c) => {
	const authContext = c.get('authContext');
	if (!authContext) {
		return c.json(
			{
				error: 'Authentication required',
				code: 'AUTH_CONTEXT_MISSING',
				details: null,
				hint: 'sessionMiddleware must run before this route',
			},
			401
		);
	}
	// Fetch full user record for name/idp_type
	let userRecord = null;
	if (c.env.DB) {
		userRecord = await getUserById(c.env.DB, authContext.user.id);
	}
	return c.json({
		user: {
			id: authContext.user.id,
			email: authContext.user.email,
			name: userRecord?.name ?? null,
			idp_type: userRecord?.idp_type ?? null,
			role: authContext.role,
		},
		contract: apiContract(),
	});
});
