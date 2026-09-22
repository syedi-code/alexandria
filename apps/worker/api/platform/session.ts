import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env, AuthContext } from '@alexandria/core';
import {
	adoptGuest,
	admitGuestFrom,
	createGuest,
	createSession,
	deleteSession,
	getSessionByToken,
	hashAddress,
	upsertUser,
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
import { passedTurnstile } from './turnstile.js';

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

	// A live session is answered as it is — unless it is a guest's and the
	// visitor has just signed in, in which case the guest is carried into the
	// account below rather than answered as a guest again.
	const jwtToken = c.req.header('cf-access-jwt-assertion');
	const existingToken = getCookie(c, '__session');
	const existing = existingToken
		? await getSessionByToken(db, existingToken)
		: null;
	const guest = existing?.is_guest === 1 ? existing : null;
	if (existing && !(guest && jwtToken)) {
		return c.json(
			{
				user: { id: existing.user_id, email: existing.email },
				role: existing.role,
				guest: existing.is_guest === 1,
				contract: apiContract(),
			},
			200
		);
	}

	// Local dev: stand in for Access, which is not in front of a local process.
	if (isLocalDev(c)) {
		const { user, role } = localDevIdentity(c.env);
		return c.json({ user, role, contract: apiContract() }, 200);
	}

	// Verify CF Access JWT (one-time)
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

		// The questions a guest asked, and their conversations, are the
		// reader's now. The guest's session goes with the guest.
		if (guest) {
			try {
				await adoptGuest(db, guest.user_id, sub);
			} catch (error) {
				console.error('[Session] adopting the guest failed:', error);
			}
		}

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
				guest: false,
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

// POST /api/session/guest — a visitor, before signing in (scribe#38).
// Registered before the session middleware, like POST /session. Off until
// TURNSTILE_SECRET is set. A guest costs money with every question, so one
// is made only for a Turnstile token Cloudflare vouches for, and only a few
// a day for any one address.
sessionRoutes.post('/session/guest', async (c) => {
	const db = c.env.DB;
	const secret = c.env.TURNSTILE_SECRET;
	if (!secret) {
		return c.json(
			{ error: 'Visitors cannot ask yet.', code: 'GUESTS_NOT_OPEN' },
			501
		);
	}

	// Whoever already holds a session keeps it: this never mints a second.
	const held = getCookie(c, '__session');
	const existing = held ? await getSessionByToken(db, held) : null;
	if (existing) {
		return c.json({
			user: { id: existing.user_id, email: existing.email },
			role: existing.role,
			guest: existing.is_guest === 1,
			contract: apiContract(),
		});
	}

	let body: { turnstile_token?: unknown };
	try {
		body = await c.req.json();
	} catch {
		body = {};
	}
	const address = c.req.header('cf-connecting-ip');
	const token =
		typeof body.turnstile_token === 'string' ? body.turnstile_token : '';
	if (!(await passedTurnstile(secret, token, address))) {
		return c.json(
			{ error: 'The check did not pass.', code: 'TURNSTILE_FAILED' },
			403
		);
	}

	// No address means no cap to hold it to, so no guest: everything that
	// reaches the deployed worker through Cloudflare carries one.
	if (
		!address ||
		!(await admitGuestFrom(db, await hashAddress(address, secret)))
	) {
		return c.json(
			{
				error: 'Too many visitors from here today. Sign in to ask.',
				code: 'GUEST_LIMIT_REACHED',
			},
			429
		);
	}

	const { id, email } = await createGuest(db);
	const durationHours = sessionDurationHours(c.env.SESSION_DURATION_HOURS);
	const session = await createSession(db, {
		userId: id,
		email,
		role: 'member',
		durationHours,
	});
	setCookie(c, '__session', session.token, {
		path: '/api',
		httpOnly: true,
		secure: !isLocalDev(c),
		sameSite: 'Lax',
		maxAge: durationHours * 60 * 60,
	});
	return c.json(
		{
			user: { id, email },
			role: 'member',
			guest: true,
			contract: apiContract(),
		},
		201
	);
});

// DELETE /api/session — sign out.
// Signing out of Access alone is not enough: POST /session answers with any
// session the cookie still names, so the next person to sign in on this
// browser would be told they were the last one. Mounted before the session
// middleware so a cookie that has already expired can still be cleared.
sessionRoutes.delete('/session', async (c) => {
	const token = getCookie(c, '__session');
	if (token && c.env.DB) await deleteSession(c.env.DB, token);
	deleteCookie(c, '__session', { path: '/api' });
	return c.body(null, 204);
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
			plan: userRecord?.plan ?? 'free',
			guest: authContext.guest === true,
		},
		contract: apiContract(),
	});
});
