import { createRemoteJWKSet, jwtVerify } from 'jose';
import type {
	FlattenedJWSInput,
	JWSHeaderParameters,
	JWTPayload,
	GetKeyFunction,
} from 'jose';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import {
	getSessionByToken,
	extendSession,
	sessionNeedsExtending,
	sessionDurationHours,
} from '@alexandria/core';
import { hasValidFileSignature } from './platform/file-access.js';
import type {
	AuthContext,
	Env,
	AuthErrorCode,
	UserRole,
} from '@alexandria/core';

type AppEnv = {
	Variables: { authContext: AuthContext };
	Bindings: Env;
};

// Module-level JWKS cache — survives across requests within the same Worker isolate.
let cachedJWKS: GetKeyFunction<JWSHeaderParameters, FlattenedJWSInput> | null =
	null;
let cachedTeamDomain: string | null = null;

/**
 * Verify a CF Access JWT issued for the given Access application. Retains
 * jose/JWKS caching internally.
 */
export async function verifyAccessJwt(
	env: Env,
	token: string,
	audience: string | undefined
): Promise<JWTPayload> {
	const teamDomain = env.TEAM_DOMAIN;

	if (!teamDomain || !audience) {
		throw new Error('SERVER_CONFIG_ERROR: TEAM_DOMAIN or audience missing');
	}

	if (!cachedJWKS || cachedTeamDomain !== teamDomain) {
		cachedJWKS = createRemoteJWKSet(
			new URL(`${teamDomain}/cdn-cgi/access/certs`)
		);
		cachedTeamDomain = teamDomain;
	}

	const { payload } = await jwtVerify(token, cachedJWKS, {
		issuer: teamDomain,
		audience,
		clockTolerance: 300, // Allow up to 5 minutes past expiry for slow connections
	});
	return payload;
}

/**
 * Verify a CF Access JWT and return the user identity.
 * Used only by the POST /api/session handler — no other route calls this.
 */
export async function verifyJwtAndGetIdentity(
	env: Env,
	token: string
): Promise<{ sub: string; email: string }> {
	const payload = await verifyAccessJwt(env, token, env.POLICY_AUD);

	return {
		sub: payload.sub as string,
		email: payload.email as string,
	};
}

/**
 * Whether Access may be skipped, because this is a local `wrangler dev`.
 *
 * Nothing in the request can prove it. `wrangler dev` populates `request.cf`
 * with real geolocation, and simulates the custom domain from wrangler.toml,
 * so a local request is indistinguishable from a deployed one by hostname or
 * by `cf` — both were tried.
 *
 * So this is exactly as trustworthy as the variable, and the variable is
 * guarded where it can be: `npm run assert:deployable` fails a deploy whose
 * target has LOCAL_DEV set, and the deploy workflow runs it before shipping.
 * Never set LOCAL_DEV outside .dev.vars.
 */
export function isLocalDev(c: { env: Env }): boolean {
	return c.env.LOCAL_DEV === 'true';
}

export const LOCAL_DEV_USER_ID = '00000000-0000-4000-8000-000000000000';

export const localDevIdentity = (env: Env) => ({
	user: {
		id: env.LOCAL_DEV_USER_ID ?? LOCAL_DEV_USER_ID,
		email: env.ADMIN_EMAIL ?? 'dev@localhost',
	},
	role: (env.ADMIN_EMAIL ? 'admin' : 'member') as UserRole,
});

/**
 * Session-based auth middleware.
 *
 * Reads the __session cookie, looks up the session in D1, extends the sliding
 * window expiry, and sets authContext on the Hono context for downstream handlers.
 *
 * The POST /api/session route is registered BEFORE this global middleware,
 * so it bypasses session auth (it uses JWT auth instead).
 */
export function sessionMiddleware(): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		// Allow CORS preflight through without auth
		if (c.req.method === 'OPTIONS') {
			return next();
		}

		// A correctly signed file URL stands in for a session: it is meant to
		// work in an <img> tag and a PDF viewer, neither of which sends the
		// cookie. The signature is verified here, not merely looked for.
		if (await hasValidFileSignature(c)) {
			return next();
		}

		const sessionToken = getCookie(c, '__session');

		// Local dev: stand in for Access, which is not in front of a local
		// process. isLocalDev() refuses to do this on a deployed worker.
		if (!sessionToken && isLocalDev(c)) {
			c.set('authContext', localDevIdentity(c.env));
			return next();
		}

		if (!sessionToken) {
			return c.json(
				{
					error: 'Session required',
					code: 'SESSION_MISSING' satisfies AuthErrorCode,
				},
				401
			);
		}

		const session = await getSessionByToken(c.env.DB, sessionToken);
		if (!session) {
			return c.json(
				{
					error: 'Session expired',
					code: 'SESSION_EXPIRED' satisfies AuthErrorCode,
				},
				401
			);
		}

		// Sliding window, but only once the session is past halfway: a write on
		// every request is what exhausted D1's daily row budget. The bump is also
		// not worth the request — the session is already valid, so a D1 that
		// refuses the write degrades the window instead of 500ing a read.
		const durationHours = sessionDurationHours(
			c.env.SESSION_DURATION_HOURS
		);
		if (sessionNeedsExtending(session.expires_at, durationHours)) {
			try {
				await extendSession(c.env.DB, sessionToken, durationHours);
			} catch (error) {
				console.error('[auth] session extend failed', error);
			}
		}

		c.set('authContext', {
			user: { id: session.user_id, email: session.email },
			role: session.role,
		});

		return next();
	};
}

/**
 * Middleware that requires a valid auth context to be present.
 * Returns 401 if sessionMiddleware did not set authContext.
 * Use this on routes that need guaranteed user identity.
 */
export function requireAuth(): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const authContext = c.get('authContext');
		if (!authContext) {
			return c.json(
				{
					error: 'Authentication required',
					code: 'AUTH_CONTEXT_MISSING' satisfies AuthErrorCode,
					details: null,
					hint: 'sessionMiddleware must run before requireAuth in the middleware chain',
				},
				401
			);
		}
		return next();
	};
}

/**
 * Middleware that requires the authenticated user to be an admin.
 * Must be used after sessionMiddleware.
 */
export function adminOnlyMiddleware(): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const authContext = c.get('authContext');
		if (!authContext || authContext.role !== 'admin') {
			return c.json({ error: 'Admin access required' }, 403);
		}
		return next();
	};
}
