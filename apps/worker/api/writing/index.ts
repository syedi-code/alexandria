import { Hono } from 'hono';
import type { Env, AuthContext } from '@alexandria/core';
import libraryRoutes from './library.js';
import essayImageRoutes from './essay-images.js';
import thoughtsRouter from './thoughts.js';
import notesRouter from './notes.js';
import quotesRouter from './quotes.js';
import mediaRouter from './media.js';
import linksRouter from './links.js';
import sleepRouter from './sleep.js';
import connectionsRouter from './connections.js';
import threadsRouter from './threads.js';
import essaysRouter from './essays.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

app.route('/', essayImageRoutes);
app.route('/thoughts', thoughtsRouter);
app.route('/notes', notesRouter);
app.route('/quotes', quotesRouter);
app.route('/media', mediaRouter);
app.route('/links', linksRouter);
app.route('/sleep', sleepRouter);
app.route('/connections', connectionsRouter);
app.route('/threads', threadsRouter);
app.route('/essays', essaysRouter);

export { libraryRoutes };
export default app;
