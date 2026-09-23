import {
	describe,
	it,
	expect,
	beforeAll,
	beforeEach,
	afterEach,
	vi,
} from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import router from '../api/router.js';
import server from '../server.js';
import {
	migratedTestDatabase,
	type TestDatabase,
} from '../../../packages/core/test/d1.js';
import {
	adoptGuest,
	GUEST_TURNS,
	GUESTS_PER_ADDRESS_PER_DAY,
	GUESTS_PER_DAY,
	pruneGuests,
} from '@alexandria/core/platform';

/**
 * Visitors (scribe#38): a guest is made only past Turnstile and under a cap
 * per address, reaches only what a visitor needs, asks three questions ever,
 * and on signing in is carried whole into the real account.
 *
 * Sign-in is tested through the real verifier: tokens here are signed with a
 * key generated for the run, and the key set is served where Access serves
 * its own, so `POST /session` checks them exactly as it checks Cloudflare's.
 */

const TEAM = 'https://team.cloudflareaccess.test';
const AUD = 'aud-github';
const AUD_OTHER = 'aud-google';
const SECRET = 'turnstile-secret';

let db: TestDatabase;
let privateKey: CryptoKey;
let jwks: object;
let turnstile: 'pass' | 'fail' | 'down';
let siteverifyCalls: FormData[];

beforeAll(async () => {
	const pair = await generateKeyPair('RS256');
	privateKey = pair.privateKey;
	jwks = {
		keys: [
			{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' },
		],
	};
});

beforeEach(() => {
	db = migratedTestDatabase();
	turnstile = 'pass';
	siteverifyCalls = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			const href = String(url);
			if (href === `${TEAM}/cdn-cgi/access/certs`) {
				return new Response(JSON.stringify(jwks), {
					headers: { 'content-type': 'application/json' },
				});
			}
			if (href.includes('turnstile/v0/siteverify')) {
				siteverifyCalls.push(init?.body as FormData);
				if (turnstile === 'down') throw new Error('unreachable');
				return new Response(
					JSON.stringify({ success: turnstile === 'pass' })
				);
			}
			throw new Error(`unexpected fetch: ${href}`);
		})
	);
});

afterEach(() => {
	db.close();
	vi.unstubAllGlobals();
});

const ENV = (over: Record<string, unknown> = {}) => ({
	DB: db.d1,
	LOCAL_DEV: 'false',
	ADMIN_EMAIL: 'admin@readers.test',
	TEAM_DOMAIN: TEAM,
	POLICY_AUD: `${AUD}, ${AUD_OTHER}`,
	TURNSTILE_SECRET: SECRET,
	OPENAI_API_KEY: 'k',
	...over,
});

function call(
	path: string,
	{
		method = 'GET',
		cookie,
		address = '203.0.113.7',
		jwt,
		body,
		env = ENV(),
	}: {
		method?: string;
		cookie?: string;
		address?: string | null;
		jwt?: string;
		body?: unknown;
		env?: Record<string, unknown>;
	} = {}
) {
	const headers: Record<string, string> = {};
	if (cookie) headers.cookie = cookie;
	if (address) headers['cf-connecting-ip'] = address;
	if (jwt) headers['cf-access-jwt-assertion'] = jwt;
	if (body !== undefined) headers['content-type'] = 'application/json';
	return router.fetch(
		new Request(`http://alexandria.test${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		env
	);
}

const sessionCookie = (response: Response) => {
	const set = response.headers.get('set-cookie') ?? '';
	const token = /__session=([^;]+)/.exec(set)?.[1];
	return token ? `__session=${token}` : null;
};

const becomeGuest = async (address = '203.0.113.7') => {
	const response = await call('/session/guest', {
		method: 'POST',
		address,
		body: { turnstile_token: 'token-from-the-widget' },
	});
	expect(response.status).toBe(201);
	const body = (await response.json()) as { user: { id: string } };
	return { cookie: sessionCookie(response)!, id: body.user.id };
};

const signed = (sub: string, email: string, audience = AUD) =>
	new SignJWT({ email })
		.setProtectedHeader({ alg: 'RS256', kid: 'k1' })
		.setSubject(sub)
		.setIssuer(TEAM)
		.setAudience(audience)
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(privateKey);

const count = (sql: string, ...args: string[]) =>
	(db.raw.prepare(sql).get(...args) as { n: number }).n;

describe('POST /session/guest', () => {
	it('is closed until Turnstile is set up', async () => {
		const response = await call('/session/guest', {
			method: 'POST',
			body: { turnstile_token: 't' },
			env: ENV({ TURNSTILE_SECRET: undefined }),
		});
		expect(response.status).toBe(501);
		expect(await response.json()).toMatchObject({
			code: 'GUESTS_NOT_OPEN',
		});
	});

	it('makes a guest past Turnstile, with a session of its own', async () => {
		const { cookie, id } = await becomeGuest();
		expect(id).toMatch(/^guest-/);
		expect(
			count(`SELECT COUNT(*) AS n FROM users WHERE is_guest = 1`)
		).toBe(1);

		const me = (await (await call('/me', { cookie })).json()) as {
			user: { guest: boolean };
		};
		expect(me.user.guest).toBe(true);

		// Turnstile was asked on the server, with our secret and their address.
		expect(siteverifyCalls[0].get('secret')).toBe(SECRET);
		expect(siteverifyCalls[0].get('remoteip')).toBe('203.0.113.7');
	});

	it('makes no guest when Turnstile says no, or cannot be reached', async () => {
		for (const outcome of ['fail', 'down'] as const) {
			turnstile = outcome;
			const response = await call('/session/guest', {
				method: 'POST',
				body: { turnstile_token: 't' },
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				code: 'TURNSTILE_FAILED',
			});
		}
		const missing = await call('/session/guest', {
			method: 'POST',
			body: {},
		});
		expect(missing.status).toBe(403);
		expect(count(`SELECT COUNT(*) AS n FROM users`)).toBe(0);
	});

	it('never mints a second session for someone holding one', async () => {
		const { cookie, id } = await becomeGuest();
		const again = await call('/session/guest', {
			method: 'POST',
			cookie,
			body: { turnstile_token: 't' },
		});
		expect(again.status).toBe(200);
		expect(((await again.json()) as { user: { id: string } }).user.id).toBe(
			id
		);
		expect(count(`SELECT COUNT(*) AS n FROM users`)).toBe(1);
	});

	it('caps the guests one address can make in a day, and stores no address', async () => {
		for (let i = 0; i < GUESTS_PER_ADDRESS_PER_DAY; i++)
			await becomeGuest();
		const over = await call('/session/guest', {
			method: 'POST',
			body: { turnstile_token: 't' },
		});
		expect(over.status).toBe(429);
		expect(await over.json()).toMatchObject({
			code: 'GUEST_LIMIT_REACHED',
		});

		// Another address is another count.
		await becomeGuest('198.51.100.20');

		// The day's own total shares the table under a key that is not a hash,
		// so it can never collide with one.
		const stored = (
			db.raw.prepare(`SELECT ip_hash FROM guest_ips`).all() as {
				ip_hash: string;
			}[]
		).filter(({ ip_hash }) => ip_hash !== 'all');
		expect(stored).toHaveLength(2);
		for (const { ip_hash } of stored) {
			expect(ip_hash).toMatch(/^[0-9a-f]{64}$/);
			expect(ip_hash).not.toContain('203.0.113.7');
		}
	});

	// The bound that actually protects the bill, and the one that fails closed
	// for people who have done nothing wrong — so it is held to firing only
	// where it is meant to.
	it("refuses everyone once the day's ceiling is reached, whatever the address", async () => {
		db.raw
			.prepare(
				`INSERT INTO guest_ips (ip_hash, day, count) VALUES ('all', ?, ?)`
			)
			.run(new Date().toISOString().slice(0, 10), GUESTS_PER_DAY);

		const over = await call('/session/guest', {
			method: 'POST',
			address: '198.51.100.77',
			body: { turnstile_token: 't' },
		});
		expect(over.status).toBe(429);
		expect(count(`SELECT COUNT(*) AS n FROM users`)).toBe(0);
	});

	it('makes no guest for a request with no address to cap', async () => {
		const response = await call('/session/guest', {
			method: 'POST',
			address: null,
			body: { turnstile_token: 't' },
		});
		expect(response.status).toBe(429);
	});
});

describe('what a guest may reach', () => {
	it('reads the catalogue and asks questions', async () => {
		const { cookie } = await becomeGuest();
		for (const path of ['/me', '/models', '/plans', '/conversations']) {
			expect((await call(path, { cookie })).status, path).toBe(200);
		}
		const created = await call('/conversations', {
			method: 'POST',
			cookie,
			body: {},
		});
		expect(created.status).toBe(201);
	});

	it('reaches nothing else, whatever the route', async () => {
		const { cookie } = await becomeGuest();
		for (const [method, path] of [
			['GET', '/books'],
			['GET', '/notes'],
			['POST', '/files/sign'],
			['GET', '/files/works/x.pdf'],
			['GET', '/documents/x/pages?from=1'],
			['GET', '/cited/x/pages/1/scan'],
			['GET', '/billing'],
			['POST', '/billing/checkout'],
			['POST', '/billing/portal'],
			['GET', '/audit'],
			['POST', '/upload/pdf'],
		]) {
			const response = await call(path, { method, cookie });
			expect(response.status, `${method} ${path}`).toBe(403);
			expect(await response.json()).toMatchObject({
				code: 'ACCOUNT_REQUIRED',
			});
		}
	});

	it('asks three questions ever, then is asked to sign in', async () => {
		const { cookie, id } = await becomeGuest();
		const { conversation } = (await (
			await call('/conversations', { method: 'POST', cookie, body: {} })
		).json()) as { conversation: { id: string } };

		// Three questions across three months: a guest's never reset.
		for (const [n, month] of [
			[1, '2026-07'],
			[2, '2026-08'],
			[3, '2026-09'],
		] as const) {
			db.raw
				.prepare(
					`INSERT INTO usage_events (id, user_id, billing_month, kind, created_at)
					 VALUES (?, ?, ?, 'chat_turn', ?)`
				)
				.run(`u${n}`, id, month, `${month}-02T00:00:00Z`);
		}

		const models = (await (await call('/models', { cookie })).json()) as {
			allowance: {
				guest: boolean;
				used: number;
				limit: number;
				resets_at: null;
			};
		};
		expect(models.allowance).toMatchObject({
			guest: true,
			used: GUEST_TURNS,
			limit: GUEST_TURNS,
			resets_at: null,
		});

		const refused = await call(`/conversations/${conversation.id}/chat`, {
			method: 'POST',
			cookie,
			body: {
				message: {
					role: 'user',
					parts: [{ type: 'text', text: 'Kant?' }],
				},
			},
		});
		expect(refused.status).toBe(402);
		expect(await refused.json()).toMatchObject({
			code: 'SIGN_IN_REQUIRED',
		});
	});
});

describe('the boundary, as production mounts it', () => {
	// Deployed, every path carries /api; the allow list must read it the same.
	it('holds under /api too', async () => {
		const { cookie } = await becomeGuest();
		const fetchAt = (path: string) =>
			server.fetch(
				new Request(`http://alexandria.test/api${path}`, {
					headers: { cookie },
				}),
				ENV()
			);
		expect((await fetchAt('/models')).status).toBe(200);
		expect((await fetchAt('/books')).status).toBe(403);
		expect((await fetchAt('/billing')).status).toBe(403);
	});
});

describe('signing in as a guest', () => {
	async function guestWithHistory() {
		const guest = await becomeGuest();
		const { conversation } = (await (
			await call('/conversations', {
				method: 'POST',
				cookie: guest.cookie,
				body: {},
			})
		).json()) as { conversation: { id: string } };
		db.raw
			.prepare(
				`INSERT INTO usage_events (id, user_id, billing_month, kind, conversation_id, created_at)
				 VALUES ('g1', ?, '2026-09', 'chat_turn', ?, '2026-09-02T00:00:00Z')`
			)
			.run(guest.id, conversation.id);
		return { ...guest, conversation: conversation.id };
	}

	it('carries the guest’s conversations and questions into the account', async () => {
		const guest = await guestWithHistory();
		const response = await call('/session', {
			method: 'POST',
			cookie: guest.cookie,
			jwt: await signed('sub-ada', 'ada@readers.test'),
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			user: { id: 'sub-ada' },
			guest: false,
		});

		expect(
			count(
				`SELECT COUNT(*) AS n FROM conversations WHERE user_id = 'sub-ada'`
			)
		).toBe(1);
		expect(
			count(
				`SELECT COUNT(*) AS n FROM usage_events WHERE user_id = 'sub-ada'`
			)
		).toBe(1);
		expect(
			count(`SELECT COUNT(*) AS n FROM users WHERE id = ?`, guest.id)
		).toBe(0);
		expect(
			count(
				`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`,
				guest.id
			)
		).toBe(0);

		// The new cookie is the account's, and the conversation opens with it.
		const cookie = sessionCookie(response)!;
		expect(cookie).not.toBe(guest.cookie);
		expect(
			(await call(`/conversations/${guest.conversation}`, { cookie }))
				.status
		).toBe(200);
	});

	it('accepts a sign-in through any of the listed Access apps', async () => {
		const response = await call('/session', {
			method: 'POST',
			jwt: await signed('sub-ben', 'ben@readers.test', AUD_OTHER),
		});
		expect(response.status).toBe(201);
	});

	it('refuses a token for an app it does not list, and leaves the guest alone', async () => {
		const guest = await guestWithHistory();
		const response = await call('/session', {
			method: 'POST',
			cookie: guest.cookie,
			jwt: await signed(
				'sub-eve',
				'eve@readers.test',
				'aud-someone-else'
			),
		});
		expect(response.status).toBe(401);
		expect(
			count(`SELECT COUNT(*) AS n FROM users WHERE id = ?`, guest.id)
		).toBe(1);
		expect(
			count(
				`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?`,
				guest.id
			)
		).toBe(1);
	});

	it('answers a guest without a sign-in as the guest', async () => {
		const guest = await becomeGuest();
		const response = await call('/session', {
			method: 'POST',
			cookie: guest.cookie,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			user: { id: guest.id },
			guest: true,
		});
	});

	it('never empties a real account into another', async () => {
		db.raw
			.prepare(
				`INSERT INTO users (id, email, first_seen, last_seen) VALUES
				 ('real-a', 'a@readers.test', '2026-01-01', '2026-01-01'),
				 ('real-b', 'b@readers.test', '2026-01-01', '2026-01-01')`
			)
			.run();
		expect(await adoptGuest(db.d1, 'real-a', 'real-b')).toBe(false);
		expect(
			count(`SELECT COUNT(*) AS n FROM users WHERE id = 'real-a'`)
		).toBe(1);
	});
});

describe('pruneGuests', () => {
	const guestMadeDaysAgo = (id: string, days: number) => {
		const at = new Date(Date.now() - days * 864e5).toISOString();
		db.raw
			.prepare(
				`INSERT INTO users (id, email, first_seen, last_seen, is_guest)
				 VALUES (?, ?, ?, ?, 1)`
			)
			.run(id, `${id}@guest.invalid`, at, at);
		return at;
	};

	it('removes a guest unused for 30 days, with everything it had', async () => {
		const at = guestMadeDaysAgo('guest-old', 40);
		db.raw
			.prepare(
				`INSERT INTO conversations (id, user_id, model_id, created_at, updated_at)
				 VALUES ('c-old', 'guest-old', 'gpt-5.6-luna', ?, ?)`
			)
			.run(at, at);
		db.raw
			.prepare(
				`INSERT INTO usage_events (id, user_id, billing_month, kind, created_at)
				 VALUES ('u-old', 'guest-old', '2026-08', 'chat_turn', ?)`
			)
			.run(at);

		expect(await pruneGuests(db.d1)).toBe(1);
		expect(count(`SELECT COUNT(*) AS n FROM users`)).toBe(0);
		expect(count(`SELECT COUNT(*) AS n FROM conversations`)).toBe(0);
		expect(count(`SELECT COUNT(*) AS n FROM usage_events`)).toBe(0);
	});

	it('keeps a guest made recently, or still asking', async () => {
		guestMadeDaysAgo('guest-new', 3);
		guestMadeDaysAgo('guest-busy', 40);
		const now = new Date().toISOString();
		db.raw
			.prepare(
				`INSERT INTO conversations (id, user_id, model_id, created_at, updated_at)
				 VALUES ('c-busy', 'guest-busy', 'gpt-5.6-luna', ?, ?)`
			)
			.run(now, now);

		expect(await pruneGuests(db.d1)).toBe(0);
	});

	it('never touches a real account', async () => {
		db.raw
			.prepare(
				`INSERT INTO users (id, email, first_seen, last_seen) VALUES
				 ('real', 'real@readers.test', '2020-01-01', '2020-01-01')`
			)
			.run();
		expect(await pruneGuests(db.d1)).toBe(0);
		expect(count(`SELECT COUNT(*) AS n FROM users`)).toBe(1);
	});
});
