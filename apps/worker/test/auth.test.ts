import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import router from '../api/router.js';
import {
	migratedTestDatabase,
	type TestDatabase,
} from '../../../packages/core/test/d1.js';

let db: TestDatabase;

beforeEach(() => {
	db = migratedTestDatabase();
});

afterEach(() => db.close());

/**
 * LOCAL_DEV stands in for Cloudflare Access, which is not in front of a local
 * process. It grants an admin context, so it is the most dangerous variable
 * here — and nothing in a request can tell a local process from a deployed
 * one. `wrangler dev` populates `request.cf` with real geolocation and
 * simulates the custom domain from wrangler.toml, so hostname and `cf` are
 * both useless as discriminators; each was tried.
 *
 * It is therefore trusted at runtime, and refused at deploy time by
 * cli/deploy/assert-deployable.ts. What is worth pinning down here is that it
 * does nothing unless set, and that it never runs as a real user by default.
 */
describe('the LOCAL_DEV bypass', () => {
	const call = (env: Record<string, unknown> = {}) =>
		router.fetch(new Request('http://localhost:8787/me'), {
			DB: db.d1,
			ADMIN_EMAIL: 'admin@example.test',
			...env,
		});

	it('does nothing unless it is exactly "true"', async () => {
		for (const LOCAL_DEV of [undefined, '', 'false', '1', 'TRUE', 'yes']) {
			expect((await call({ LOCAL_DEV })).status).toBe(401);
		}
	});

	it('stands in for a session when it is set', async () => {
		expect((await call({ LOCAL_DEV: 'true' })).status).toBe(200);
	});

	it('does not run as a real user unless one is configured', async () => {
		const body = (await (await call({ LOCAL_DEV: 'true' })).json()) as {
			user: { id: string };
		};
		expect(body.user.id).toBe('00000000-0000-4000-8000-000000000000');
	});

	it('runs as the configured developer when one is set', async () => {
		const body = (await (
			await call({ LOCAL_DEV: 'true', LOCAL_DEV_USER_ID: 'my-user' })
		).json()) as { user: { id: string } };
		expect(body.user.id).toBe('my-user');
	});

	it('is a member, not an admin, without ADMIN_EMAIL', async () => {
		const body = (await (
			await call({ LOCAL_DEV: 'true', ADMIN_EMAIL: undefined })
		).json()) as { user: { role: string } };
		expect(body.user.role).toBe('member');
	});
});
