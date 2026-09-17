/// <reference types="@cloudflare/workers-types" />
import { createNote } from './notes.js';
import { createQuote } from './quotes.js';
import { createThread, addThreadItem } from './threads.js';
import {
	WELCOME_NOTES,
	WELCOME_QUOTES,
	WELCOME_THOUGHTS,
	WELCOME_THREAD,
} from './welcome-data.js';

/**
 * Populate welcome content for a new user on first login.
 *
 * - Checks the `welcome_completed` flag to avoid duplicates
 * - Creates notes, quotes, thoughts, and a thread grouping them
 * - Sets `welcome_completed = 1` on success
 * - Errors are caught internally — this must never block login
 */
export async function populateWelcomeData(
	db: D1Database,
	userId: string
): Promise<void> {
	try {
		// Check if welcome data was already populated
		const user = await db
			.prepare('SELECT welcome_completed FROM users WHERE id = ?')
			.bind(userId)
			.first<{ welcome_completed: number }>();

		if (!user || user.welcome_completed === 1) return;

		const createdEntityIds: { type: string; id: string }[] = [];

		// Create welcome notes
		for (const noteInput of WELCOME_NOTES) {
			const note = await createNote(db, noteInput, undefined, userId);
			createdEntityIds.push({ type: 'note', id: note.id });
		}

		// Create welcome quotes
		for (const quoteInput of WELCOME_QUOTES) {
			const quote = await createQuote(db, quoteInput, undefined, userId);
			createdEntityIds.push({ type: 'quote', id: quote.id });
		}

		// Create welcome thoughts (inline — createThought lives in worker, not core)
		for (const thoughtInput of WELCOME_THOUGHTS) {
			const id = crypto.randomUUID();
			const created_at = new Date().toISOString();
			const author = thoughtInput.author || 'web';
			const mood_tags_json = thoughtInput.mood_tags
				? JSON.stringify(thoughtInput.mood_tags)
				: null;

			await db
				.prepare(
					'INSERT INTO thoughts (id, content, author, created_at, mood_score, mood_tags, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
				)
				.bind(
					id,
					thoughtInput.content,
					author,
					created_at,
					thoughtInput.mood_score ?? null,
					mood_tags_json,
					userId
				)
				.run();

			createdEntityIds.push({ type: 'thought', id });
		}

		// Create welcome thread and add all items to it
		const thread = await createThread(db, WELCOME_THREAD, userId);
		for (const entity of createdEntityIds) {
			await addThreadItem(db, thread.id, entity.type, entity.id, userId);
		}

		// Mark welcome as completed
		await db
			.prepare('UPDATE users SET welcome_completed = 1 WHERE id = ?')
			.bind(userId)
			.run();
	} catch (err) {
		// Welcome data is non-critical — log but never throw
		console.error('[Welcome] Failed to populate welcome data:', err);
	}
}
