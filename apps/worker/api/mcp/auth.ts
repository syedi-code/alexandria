import type { MiddlewareHandler } from 'hono';
import type { Env } from '@alexandria/core/platform';
import { isLocalDev, verifyAccessJwt } from '../auth.js';

/**
 * Access rejects any /mcp request without the service token before it reaches
 * the worker. This proves the request really came through that Access
 * application, with that token, rather than trusting the edge configuration.
 */
export function serviceTokenAuth(): MiddlewareHandler<{ Bindings: Env }> {
	return async (c, next) => {
		if (isLocalDev(c)) return next();

		const { MCP_POLICY_AUD, MCP_SERVICE_TOKEN_ID } = c.env;
		if (!MCP_POLICY_AUD || !MCP_SERVICE_TOKEN_ID) {
			return c.json({ error: 'MCP is not configured' }, 503);
		}

		const token = c.req.header('cf-access-jwt-assertion');
		if (!token) return c.json({ error: 'Access token required' }, 401);

		try {
			const payload = await verifyAccessJwt(c.env, token, MCP_POLICY_AUD);
			if (payload.common_name !== MCP_SERVICE_TOKEN_ID) {
				return c.json({ error: 'This token may not use MCP' }, 403);
			}
		} catch {
			return c.json({ error: 'Invalid Access token' }, 401);
		}

		return next();
	};
}
