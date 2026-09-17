/// <reference types="@cloudflare/workers-types" />
import type { Creator, CreatorInput } from './schema.js';

export async function createCreator(
	db: D1Database,
	input: CreatorInput,
	userId?: string
): Promise<Creator> {
	const now = new Date().toISOString();
	const creator: Creator = {
		id: input.id || crypto.randomUUID(),
		name: input.name,
		bio: input.bio,
		born: input.born,
		died: input.died,
		created_at: now,
		updated_at: now,
	};

	await db
		.prepare(
			`INSERT INTO creators (id, name, bio, born, died, created_at, updated_at, user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			creator.id,
			creator.name,
			creator.bio || null,
			creator.born || null,
			creator.died || null,
			creator.created_at,
			creator.updated_at,
			userId || null
		)
		.run();

	return creator;
}

export async function getCreators(
	db: D1Database,
	options: { limit?: number; offset?: number; search?: string } = {}
): Promise<Creator[]> {
	const limit = options.limit ?? 100;
	const offset = options.offset ?? 0;

	let query = `SELECT id, name, bio, born, died, created_at, updated_at FROM creators WHERE 1=1`;
	const params: (string | number)[] = [];

	if (options.search) {
		query += ` AND LOWER(name) LIKE LOWER(?)`;
		params.push(`%${options.search}%`);
	}

	query += ` ORDER BY name ASC LIMIT ? OFFSET ?`;
	params.push(limit, offset);

	const result = await db
		.prepare(query)
		.bind(...params)
		.all<Creator>();

	return result.results ?? [];
}

export async function getCreatorById(
	db: D1Database,
	id: string
): Promise<Creator | null> {
	const result = await db
		.prepare(
			`SELECT id, name, bio, born, died, created_at, updated_at FROM creators WHERE id = ?`
		)
		.bind(id)
		.first<Creator>();

	return result || null;
}

export async function updateCreator(
	db: D1Database,
	id: string,
	updates: Partial<CreatorInput>
): Promise<void> {
	const existing = await getCreatorById(db, id);
	if (!existing) {
		throw new Error(`Creator not found: ${id}`);
	}

	const merged = {
		...existing,
		...updates,
		updated_at: new Date().toISOString(),
	};

	await db
		.prepare(
			`UPDATE creators SET name = ?, bio = ?, born = ?, died = ?, updated_at = ? WHERE id = ?`
		)
		.bind(
			merged.name,
			merged.bio || null,
			merged.born || null,
			merged.died || null,
			merged.updated_at,
			id
		)
		.run();
}

export async function deleteCreator(db: D1Database, id: string): Promise<void> {
	await db.prepare(`DELETE FROM creators WHERE id = ?`).bind(id).run();
}
