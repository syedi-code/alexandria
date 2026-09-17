import { describe, it, expect } from 'vitest';
import {
	DEFAULT_FILE_TOKEN_TTL_SECONDS,
	InvalidObjectKeyError,
	isSafeObjectKey,
	MAX_FILE_TOKEN_TTL_SECONDS,
	signFileToken,
	verifyFileToken,
} from '../platform/file-tokens.js';

const SECRET = 'the-file-signing-secret';
const KEY = 'books/8f1c/the-phenomenology-of-spirit.pdf';

const tokenFor = (overrides: Record<string, unknown>) =>
	btoa(JSON.stringify(overrides));

describe('signFileToken', () => {
	it('mints a token that verifies for the key it was minted for', async () => {
		const token = await signFileToken({ key: KEY, secret: SECRET });
		await expect(
			verifyFileToken({ token, key: KEY, secret: SECRET })
		).resolves.toBe(true);
	});

	it('refuses to sign a key that escapes the bucket', async () => {
		for (const key of ['/etc/passwd', '../../secrets', 'a\nb', '']) {
			await expect(
				signFileToken({ key, secret: SECRET })
			).rejects.toBeInstanceOf(InvalidObjectKeyError);
		}
	});

	it('caps the lifetime a caller can ask for', async () => {
		const now = Date.UTC(2026, 0, 1);
		const token = await signFileToken({
			key: KEY,
			secret: SECRET,
			expiresInSeconds: 10 * 365 * 24 * 3600,
			now,
		});
		const { expires } = JSON.parse(atob(token));
		expect(expires).toBe(now + MAX_FILE_TOKEN_TTL_SECONDS * 1000);
	});

	it('defaults to an hour', async () => {
		const now = Date.UTC(2026, 0, 1);
		const token = await signFileToken({ key: KEY, secret: SECRET, now });
		const { expires } = JSON.parse(atob(token));
		expect(expires).toBe(now + DEFAULT_FILE_TOKEN_TTL_SECONDS * 1000);
	});
});

describe('verifyFileToken', () => {
	// The bug this suite exists for: the middleware tested that a token was
	// present, never that it was real, so every one of these returned the file.
	it('rejects a token that was never signed', async () => {
		for (const token of ['x', 'true', '', 'null', 'undefined']) {
			await expect(
				verifyFileToken({ token, key: KEY, secret: SECRET })
			).resolves.toBe(false);
		}
	});

	it('rejects a non-string token', async () => {
		for (const token of [null, undefined, 1, true, {}, []]) {
			await expect(
				verifyFileToken({ token, key: KEY, secret: SECRET })
			).resolves.toBe(false);
		}
	});

	it('rejects a well-formed claim carrying no signature', async () => {
		const token = tokenFor({
			path: KEY,
			expires: Date.now() + 60_000,
			sig: '',
		});
		await expect(
			verifyFileToken({ token, key: KEY, secret: SECRET })
		).resolves.toBe(false);
	});

	it('rejects a forged signature', async () => {
		const token = tokenFor({
			path: KEY,
			expires: Date.now() + 60_000,
			sig: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
		});
		await expect(
			verifyFileToken({ token, key: KEY, secret: SECRET })
		).resolves.toBe(false);
	});

	it('rejects a token signed with a different secret', async () => {
		const token = await signFileToken({ key: KEY, secret: 'other-secret' });
		await expect(
			verifyFileToken({ token, key: KEY, secret: SECRET })
		).resolves.toBe(false);
	});

	it('rejects a token minted for a different object', async () => {
		const token = await signFileToken({
			key: 'books/other.pdf',
			secret: SECRET,
		});
		await expect(
			verifyFileToken({ token, key: KEY, secret: SECRET })
		).resolves.toBe(false);
	});

	// The signature covers the expiry, so pushing it out invalidates it.
	it('rejects a token whose expiry was extended after signing', async () => {
		const now = Date.UTC(2026, 0, 1);
		const token = await signFileToken({ key: KEY, secret: SECRET, now });
		const claim = JSON.parse(atob(token));
		const extended = tokenFor({ ...claim, expires: claim.expires + 1 });
		await expect(
			verifyFileToken({ token: extended, key: KEY, secret: SECRET, now })
		).resolves.toBe(false);
	});

	it('rejects an expired token', async () => {
		const now = Date.UTC(2026, 0, 1);
		const token = await signFileToken({
			key: KEY,
			secret: SECRET,
			expiresInSeconds: 60,
			now,
		});
		await expect(
			verifyFileToken({ token, key: KEY, secret: SECRET, now })
		).resolves.toBe(true);
		await expect(
			verifyFileToken({
				token,
				key: KEY,
				secret: SECRET,
				now: now + 61_000,
			})
		).resolves.toBe(false);
	});

	it('rejects an expiry that is not a number', async () => {
		for (const expires of ['9999999999999', null, {}, NaN, Infinity]) {
			const token = tokenFor({ path: KEY, expires, sig: 'x' });
			await expect(
				verifyFileToken({ token, key: KEY, secret: SECRET })
			).resolves.toBe(false);
		}
	});

	it('rejects a valid token presented for a different path', async () => {
		const token = await signFileToken({ key: KEY, secret: SECRET });
		await expect(
			verifyFileToken({
				token,
				key: 'books/somebody-elses.pdf',
				secret: SECRET,
			})
		).resolves.toBe(false);
	});

	it('rejects everything when no secret is configured', async () => {
		const token = await signFileToken({ key: KEY, secret: SECRET });
		await expect(
			verifyFileToken({ token, key: KEY, secret: '' })
		).resolves.toBe(false);
	});
});

describe('isSafeObjectKey', () => {
	it('accepts an ordinary bucket key', () => {
		expect(isSafeObjectKey(KEY)).toBe(true);
		expect(isSafeObjectKey('books/uploads/cover-a b.png')).toBe(true);
	});

	it('rejects traversal, absolute paths and control characters', () => {
		for (const key of [
			'',
			'/books/a.pdf',
			'../a.pdf',
			'books/../../a.pdf',
			'books/a\0.pdf',
			'books/a\nb.pdf',
			'a'.repeat(1025),
			null,
			42,
		]) {
			expect(isSafeObjectKey(key)).toBe(false);
		}
	});
});
