import { Hono } from 'hono';
import type { Env, AuthContext } from '@alexandria/core/platform';
import booksRoutes from './books.js';
import creatorsRoutes from './creators.js';
import documentsRoutes from './documents.js';
import mediaRoutes from './media.js';
import uploadsRoutes from './uploads.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// books.ts owns /books/:id, so it is mounted last: Hono matches in
// registration order, and a parameter would otherwise swallow the more
// specific /books/:id/media paths registered here.
app.route('/', mediaRoutes);
app.route('/', creatorsRoutes);
app.route('/', documentsRoutes);
app.route('/', uploadsRoutes);
app.route('/', booksRoutes);

export default app;
