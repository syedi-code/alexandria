/// <reference types="@cloudflare/workers-types" />
import type { UserInput, UserSchema } from './schema.js';

/**
 * Upsert a user record. Creates on first login, updates last_seen on repeat visits.
 */
export async function upsertUser(
	db: D1Database,
	input: UserInput
): Promise<UserSchema> {
	const now = new Date().toISOString();
	await db
		.prepare(
			`INSERT INTO users (id, email, name, idp_type, first_seen, last_seen)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   email = excluded.email,
			   name = excluded.name,
			   idp_type = excluded.idp_type,
			   last_seen = excluded.last_seen`
		)
		.bind(
			input.id,
			input.email,
			input.name ?? null,
			input.idp_type ?? null,
			now,
			now
		)
		.run();

	return getUserById(db, input.id) as Promise<UserSchema>;
}

/**
 * Get a user by their CF Access sub UUID.
 */
export async function getUserById(
	db: D1Database,
	id: string
): Promise<UserSchema | null> {
	const result = await db
		.prepare(`SELECT * FROM users WHERE id = ?`)
		.bind(id)
		.first<UserSchema>();
	return result ?? null;
}

/**
 * Get a user by their email address.
 */
export async function getUserByEmail(
	db: D1Database,
	email: string
): Promise<UserSchema | null> {
	const result = await db
		.prepare(`SELECT * FROM users WHERE email = ?`)
		.bind(email)
		.first<UserSchema>();
	return result ?? null;
}
