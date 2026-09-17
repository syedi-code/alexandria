import { Hono } from 'hono';
import {
	Env,
	Thought,
	ThoughtInput,
	ThoughtPatch,
	friendlyZodError,
} from '@alexandria/core';
import type { AuthContext } from '@alexandria/core';
import { requireAuth } from '../auth.js';

const app = new Hono<{
	Bindings: Env;
	Variables: { authContext: AuthContext };
}>();

// ============================================================================
// Thoughts Database Operations
// ============================================================================

/** API response type — mood_tags is parsed from JSON string to string[] */
type ThoughtResponse = Omit<Thought, 'mood_tags'> & { mood_tags?: string[] };

function parseThoughtRow(t: Thought): ThoughtResponse {
	return {
		...t,
		mood_tags: t.mood_tags
			? JSON.parse(t.mood_tags as unknown as string)
			: undefined,
	};
}

async function getThoughts(
	db: D1Database,
	options: { limit?: number; offset?: number; q?: string } = {},
	userId: string
): Promise<{ data: ThoughtResponse[]; hasMore: boolean }> {
	if (!userId) return { data: [], hasMore: false };
	const limit = options.limit ?? 50;
	const offset = options.offset ?? 0;
	const q = options.q?.trim().toLowerCase();

	let sql =
		'SELECT * FROM thoughts WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?';
	const binds: (string | number)[] = [userId, limit + 1, offset];

	if (q) {
		const pattern = `%${q}%`;
		sql =
			'SELECT * FROM thoughts WHERE user_id = ? AND (LOWER(content) LIKE ? OR LOWER(mood_tags) LIKE ?) ORDER BY created_at DESC LIMIT ? OFFSET ?';
		binds.splice(1, 0, pattern, pattern);
	}

	const result = await db
		.prepare(sql)
		.bind(...binds)
		.all<Thought>();

	const rows = result.results || [];
	const hasMore = rows.length > limit;
	const data = (hasMore ? rows.slice(0, limit) : rows).map(parseThoughtRow);

	return { data, hasMore };
}

async function getAllThoughts(
	db: D1Database,
	userId: string
): Promise<ThoughtResponse[]> {
	if (!userId) return [];
	const result = await db
		.prepare(
			'SELECT * FROM thoughts WHERE user_id = ? ORDER BY created_at DESC'
		)
		.bind(userId)
		.all<Thought>();
	return (result.results || []).map(parseThoughtRow);
}

async function getThought(
	db: D1Database,
	id: string,
	userId: string
): Promise<ThoughtResponse | null> {
	if (!userId) return null;
	const result = await db
		.prepare('SELECT * FROM thoughts WHERE id = ? AND user_id = ?')
		.bind(id, userId)
		.first<Thought>();
	if (!result) return null;
	// Parse mood_tags JSON
	return {
		...result,
		mood_tags: result.mood_tags
			? JSON.parse(result.mood_tags as unknown as string)
			: undefined,
	};
}

async function createThought(
	db: D1Database,
	input: ThoughtInput,
	userId?: string
): Promise<ThoughtResponse> {
	const id = crypto.randomUUID();
	const created_at = input.created_at || new Date().toISOString();
	const author = input.author || 'web';
	const mood_tags_json = input.mood_tags
		? JSON.stringify(input.mood_tags)
		: null;

	await db
		.prepare(
			'INSERT INTO thoughts (id, content, author, created_at, mood_score, mood_tags, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
		.bind(
			id,
			input.content,
			author,
			created_at,
			input.mood_score ?? null,
			mood_tags_json,
			userId || null
		)
		.run();

	return {
		id,
		content: input.content,
		author,
		created_at,
		mood_score: input.mood_score,
		mood_tags: input.mood_tags,
	};
}

async function getAllMoodTags(
	db: D1Database,
	userId: string
): Promise<string[]> {
	if (!userId) return [];
	const result = await db
		.prepare(
			'SELECT DISTINCT mood_tags FROM thoughts WHERE mood_tags IS NOT NULL AND user_id = ?'
		)
		.bind(userId)
		.all<{ mood_tags: string }>();

	// Collect all unique mood tags from all thoughts
	const allTags = new Set<string>();
	for (const row of result.results || []) {
		if (row.mood_tags) {
			try {
				const tags = JSON.parse(row.mood_tags);
				if (Array.isArray(tags)) {
					tags.forEach((tag) => allTags.add(tag));
				}
			} catch {
				// Ignore parse errors
			}
		}
	}

	return Array.from(allTags);
}

// Default mood tags used as fallback when DB has few/no tags
const DEFAULT_MOOD_TAGS = [
	'happy',
	'excited',
	'grateful',
	'calm',
	'hopeful',
	'anxious',
	'sad',
	'frustrated',
	'tired',
	'overwhelmed',
	'creative',
	'focused',
	'inspired',
	'nostalgic',
	'curious',
	'loved',
	'peaceful',
	'energetic',
	'silly',
	'cozy',
];

/** Fisher-Yates shuffle for true randomness */
function shuffleArray<T>(arr: T[]): T[] {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

async function getRandomMoodSuggestions(
	db: D1Database,
	count: number = 6,
	userId: string
): Promise<string[]> {
	const dbTags = await getAllMoodTags(db, userId);

	// Merge DB tags with defaults (DB tags take priority in the set)
	const merged = Array.from(new Set([...dbTags, ...DEFAULT_MOOD_TAGS]));

	// Shuffle and take the requested count
	return shuffleArray(merged).slice(0, count);
}

async function deleteThought(
	db: D1Database,
	id: string,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	await db
		.prepare('DELETE FROM thoughts WHERE id = ? AND user_id = ?')
		.bind(id, userId)
		.run();
}

async function updateThought(
	db: D1Database,
	id: string,
	input: ThoughtPatch,
	userId: string
): Promise<ThoughtResponse | null> {
	if (!userId) return null;
	const existing = await getThought(db, id, userId);
	if (!existing) return null;

	const content = input.content ?? existing.content;
	const mood_score =
		input.mood_score !== undefined ? input.mood_score : existing.mood_score;
	const mood_tags: string[] | undefined =
		input.mood_tags !== undefined
			? (input.mood_tags ?? undefined)
			: existing.mood_tags;
	const mood_tags_json = mood_tags ? JSON.stringify(mood_tags) : null;

	await db
		.prepare(
			'UPDATE thoughts SET content = ?, mood_score = ?, mood_tags = ? WHERE id = ? AND user_id = ?'
		)
		.bind(content, mood_score ?? null, mood_tags_json, id, userId)
		.run();

	return {
		...existing,
		content,
		mood_score,
		mood_tags,
	};
}

async function updateThoughtPosition(
	db: D1Database,
	id: string,
	x: number,
	y: number,
	userId: string
): Promise<void> {
	if (!userId) throw new Error('userId is required');
	await db
		.prepare(
			'UPDATE thoughts SET x = ?, y = ? WHERE id = ? AND user_id = ?'
		)
		.bind(x, y, id, userId)
		.run();
}

// ============================================================================
// Embedding Operations
// ============================================================================

async function generateEmbedding(ai: Ai, text: string): Promise<number[]> {
	const result = await ai.run('@cf/baai/bge-base-en-v1.5', {
		text: [text],
	});
	// @ts-expect-error - Workers AI types are incomplete
	return result.data[0];
}

/**
 * Project high-dimensional embeddings to 2D using simple PCA-like projection
 * This runs client-side for now; could be replaced with server-side UMAP later
 */
function projectTo2D(
	embeddings: number[][],
	_existingPositions: Map<string, { x: number; y: number }>
): { x: number; y: number }[] {
	if (embeddings.length === 0) return [];

	// Simple projection: use first two principal directions
	// For MVP, just use sum of even/odd indices as rough 2D projection
	return embeddings.map((emb) => {
		let x = 0;
		let y = 0;
		for (let i = 0; i < emb.length; i++) {
			if (i % 2 === 0) x += emb[i];
			else y += emb[i];
		}
		// Normalize to reasonable screen coordinates
		return {
			x: x * 100,
			y: y * 100,
		};
	});
}

// ============================================================================
// API Routes
// ============================================================================

// GET /thoughts - List thoughts (paginated)
app.get('/', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const limit = Number(c.req.query('limit')) || 50;
	const offset = Number(c.req.query('offset')) || 0;
	const q = c.req.query('q');

	try {
		const { data, hasMore } = await getThoughts(
			db,
			{ limit, offset, q },
			userId
		);
		return c.json({ thoughts: data, hasMore });
	} catch (error) {
		console.error('GET /thoughts error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /thoughts/moods - Get all previously used mood tags for autocomplete
app.get('/moods', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	try {
		const moods = await getAllMoodTags(db, userId);
		return c.json({ moods });
	} catch (error) {
		console.error('GET /thoughts/moods error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /thoughts/moods/suggestions - Get a random handful of mood tag suggestions
app.get('/moods/suggestions', requireAuth(), async (c) => {
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	try {
		const count = Math.min(Number(c.req.query('count')) || 6, 20);
		const suggestions = await getRandomMoodSuggestions(db, count, userId);
		return c.json({ suggestions });
	} catch (error) {
		console.error('GET /thoughts/moods/suggestions error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /thoughts/network - Get thoughts with 2D positions for visualization
app.get('/network', requireAuth(), async (c) => {
	const db = c.env.DB;
	const vectorize = c.env.VECTORIZE;
	const ai = c.env.AI;

	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	try {
		const thoughts = await getAllThoughts(db, userId);

		// If we have Vectorize and AI, compute positions from embeddings
		if (vectorize && ai && thoughts.length > 0) {
			const thoughtsNeedingPositions = thoughts.filter(
				(t) => t.x === null || t.y === null
			);

			if (thoughtsNeedingPositions.length > 0) {
				// Generate embeddings for thoughts without positions
				const embeddings = await Promise.all(
					thoughtsNeedingPositions.map((t) =>
						generateEmbedding(ai, t.content)
					)
				);

				// Store in Vectorize for similarity search
				const vectors = thoughtsNeedingPositions.map((t, i) => ({
					id: t.id,
					values: embeddings[i],
					metadata: { content: t.content.slice(0, 100) },
				}));

				await vectorize.upsert(vectors);

				// Project to 2D
				const positions = projectTo2D(embeddings, new Map());

				// Update positions in DB
				await Promise.all(
					thoughtsNeedingPositions.map((t, i) =>
						updateThoughtPosition(
							db,
							t.id,
							positions[i].x,
							positions[i].y,
							userId
						)
					)
				);

				// Update local thoughts array
				thoughtsNeedingPositions.forEach((t, i) => {
					t.x = positions[i].x;
					t.y = positions[i].y;
				});
			}
		}

		// Return thoughts - positions may be null if AI/Vectorize not configured
		return c.json({ thoughts });
	} catch (error) {
		console.error('GET /thoughts/network error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// POST /thoughts - Create a new thought
app.post('/', requireAuth(), async (c) => {
	const db = c.env.DB;
	const vectorize = c.env.VECTORIZE;
	const ai = c.env.AI;

	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const parsed = ThoughtInput.safeParse(raw);
	if (!parsed.success) {
		return c.json(
			{
				error: 'Validation failed',
				details: friendlyZodError(parsed.error),
			},
			400
		);
	}
	const body = parsed.data;

	try {
		const userId = c.get('authContext')!.user.id;
		const thought = await createThought(db, body, userId);

		// Generate embedding and position if AI is available
		if (ai && vectorize) {
			const embedding = await generateEmbedding(ai, thought.content);

			// Store in Vectorize
			await vectorize.upsert([
				{
					id: thought.id,
					values: embedding,
					metadata: { content: thought.content.slice(0, 100) },
				},
			]);

			// Simple 2D projection for new thought
			const [position] = projectTo2D([embedding], new Map());
			await updateThoughtPosition(
				db,
				thought.id,
				position.x,
				position.y,
				userId
			);
			thought.x = position.x;
			thought.y = position.y;
		}

		return c.json({ ok: true, thought }, 201);
	} catch (error) {
		console.error('POST /thoughts error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// GET /thoughts/:id/similar - Find similar thoughts
app.get('/:id/similar', requireAuth(), async (c) => {
	const db = c.env.DB;
	const vectorize = c.env.VECTORIZE;
	const ai = c.env.AI;

	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	if (!vectorize || !ai) {
		return c.json({ error: 'Vectorize/AI not configured' }, 500);
	}

	const userId = c.get('authContext')!.user.id;
	const id = c.req.param('id');
	const limit = Number(c.req.query('limit')) || 5;

	try {
		const thought = await getThought(db, id, userId);
		if (!thought) {
			return c.json({ error: 'Thought not found' }, 404);
		}

		// Generate embedding for the query thought
		const embedding = await generateEmbedding(ai, thought.content);

		// Query Vectorize for similar thoughts
		const similar = await vectorize.query(embedding, {
			topK: limit + 1, // +1 because it will include itself
			returnMetadata: 'all',
		});

		// Filter out the original thought and fetch full data
		const similarIds = similar.matches
			.filter((m) => m.id !== id)
			.slice(0, limit)
			.map((m) => m.id);

		const similarThoughts = await Promise.all(
			similarIds.map((sid) => getThought(db, sid as string, userId))
		);

		return c.json({
			thoughts: similarThoughts.filter(Boolean),
			scores: similar.matches
				.filter((m) => m.id !== id)
				.slice(0, limit)
				.map((m) => m.score),
		});
	} catch (error) {
		console.error('GET /thoughts/:id/similar error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// DELETE /thoughts/:id - Delete a thought
app.delete('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;
	const vectorize = c.env.VECTORIZE;

	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');

	try {
		// Delete from Vectorize if available
		if (vectorize) {
			await vectorize.deleteByIds([id]);
		}

		const userId = c.get('authContext')!.user.id;
		await deleteThought(db, id, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('DELETE /thoughts/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// PATCH /thoughts/:id - Update a thought (content, mood)
app.patch('/:id', requireAuth(), async (c) => {
	const db = c.env.DB;

	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');

	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const parsed = ThoughtPatch.safeParse(raw);
	if (!parsed.success) {
		return c.json(
			{
				error: 'Validation failed',
				details: friendlyZodError(parsed.error),
			},
			400
		);
	}
	const body = parsed.data;

	try {
		const userId = c.get('authContext')!.user.id;
		const thought = await updateThought(db, id, body, userId);
		if (!thought) {
			return c.json({ error: 'Thought not found' }, 404);
		}
		return c.json({ ok: true, thought });
	} catch (error) {
		console.error('PATCH /thoughts/:id error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// PATCH /thoughts/:id/position - Update thought position
app.patch('/:id/position', requireAuth(), async (c) => {
	const db = c.env.DB;

	if (!db) {
		return c.json({ error: 'Database not configured' }, 500);
	}

	const id = c.req.param('id');

	let body: { x: number; y: number };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	if (typeof body.x !== 'number' || typeof body.y !== 'number') {
		return c.json({ error: 'x and y must be numbers' }, 400);
	}

	try {
		const userId = c.get('authContext')!.user.id;
		await updateThoughtPosition(db, id, body.x, body.y, userId);
		return c.json({ ok: true });
	} catch (error) {
		console.error('PATCH /thoughts/:id/position error:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
