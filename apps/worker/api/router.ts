import { Hono } from 'hono';
import type { Env, AuthContext } from '@alexandria/core';
import { sessionMiddleware } from './auth.js';
import { sessionRoutes, identityRoutes } from './platform/session.js';
import fileRoutes from './platform/files.js';
import auditRoutes from './platform/audit.js';
import debugRouter from './platform/debug.js';
import worksRoutes from './works/index.js';
import writingRoutes, { libraryRoutes } from './writing/index.js';
import conversationRoutes from './conversations/index.js';
import mcpRoutes from './mcp/index.js';
import publicRoutes from './public.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// Hono runs the handlers matched for a request in registration order, and
// POST /session returns without calling next(). Registering it above the
// session middleware is what lets it mint a session without already holding
// one — order here is load-bearing, not stylistic.
app.route('/', sessionRoutes);

// MCP clients carry an Access service token, not a session.
app.route('/', mcpRoutes);

// The catalogue the page at / reads. Registered here because it is the one
// route that answers without a session; see api/public.ts.
app.route('/', publicRoutes);

app.use('*', sessionMiddleware());

app.route('/', identityRoutes);

// Writing's views over /books/* come first: the literal "library" segment
// has to be matched before works/ registers /books/:id. See writing/library.ts.
app.route('/', libraryRoutes);
app.route('/', worksRoutes);
app.route('/', writingRoutes);
app.route('/', conversationRoutes);

app.route('/', fileRoutes);
app.route('/', auditRoutes);
app.route('/auth/debug', debugRouter);

export default app;
