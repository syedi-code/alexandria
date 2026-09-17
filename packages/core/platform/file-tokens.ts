/**
 * Signed file tokens.
 *
 * R2 objects are served by a route that runs before session auth, so the
 * token is the only thing standing between a bucket key and the public
 * internet. It is an HMAC-SHA256 over `key:expires`, carried base64-encoded
 * alongside the values it signs.
 *
 * The wire format is fixed: stylus and scribe hold tokens minted by earlier
 * deploys, and the API is additive-only.
 */

/** An object key a token may be minted for. */
export function isSafeObjectKey(key: unknown): key is string {
	return (
		typeof key === 'string' &&
		key.length > 0 &&
		key.length <= 1024 &&
		!key.startsWith('/') &&
		!key.includes('..') &&
		// A NUL or newline cannot appear in an R2 key and would let one signed
		// value be read as another.
		!/[\0\r\n]/.test(key)
	);
}

async function hmac(secret: string, message: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode(message)
	);
	return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * Compares in time that does not depend on where the first difference is.
 * A leaked position would let a signature be recovered one character at a
 * time.
 */
function equals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++)
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export const DEFAULT_FILE_TOKEN_TTL_SECONDS = 3600;
export const MAX_FILE_TOKEN_TTL_SECONDS = 24 * 3600;

export class InvalidObjectKeyError extends Error {
	constructor(key: unknown) {
		super(`Not a signable object key: ${JSON.stringify(key)}`);
		this.name = 'InvalidObjectKeyError';
	}
}

/** Mints a token granting reads of exactly one object key, for a while. */
export async function signFileToken(params: {
	key: string;
	secret: string;
	expiresInSeconds?: number;
	now?: number;
}): Promise<string> {
	const { key, secret } = params;
	if (!isSafeObjectKey(key)) throw new InvalidObjectKeyError(key);

	const ttl = Math.min(
		Math.max(
			1,
			Math.floor(
				params.expiresInSeconds ?? DEFAULT_FILE_TOKEN_TTL_SECONDS
			)
		),
		MAX_FILE_TOKEN_TTL_SECONDS
	);
	const expires = (params.now ?? Date.now()) + ttl * 1000;

	return btoa(
		JSON.stringify({
			path: key,
			expires,
			sig: await hmac(secret, `${key}:${expires}`),
		})
	);
}

/**
 * True only for a token this secret minted, for this exact key, still inside
 * its window. Every other input — malformed, forged, expired, or for a
 * different object — is false, with no distinction drawn between them.
 */
export async function verifyFileToken(params: {
	token: unknown;
	key: string;
	secret: string;
	now?: number;
}): Promise<boolean> {
	const { token, key, secret } = params;
	if (typeof token !== 'string' || !token || !secret) return false;
	if (!isSafeObjectKey(key)) return false;

	let claim: unknown;
	try {
		claim = JSON.parse(atob(token));
	} catch {
		return false;
	}
	if (typeof claim !== 'object' || claim === null) return false;

	const { path, expires, sig } = claim as Record<string, unknown>;
	if (typeof sig !== 'string' || !sig) return false;
	if (typeof expires !== 'number' || !Number.isFinite(expires)) return false;
	if (!isSafeObjectKey(path) || path !== key) return false;
	if ((params.now ?? Date.now()) > expires) return false;

	return equals(sig, await hmac(secret, `${path}:${expires}`));
}
