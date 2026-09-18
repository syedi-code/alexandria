import type { Env } from '@alexandria/core/platform';
import { verifyFileToken } from '@alexandria/core/platform';

/** Only what the check reads, so any Hono context satisfies it. */
interface FileRequest {
	env: Env;
	req: { path: string; query(key: string): string | undefined };
}

/**
 * Object reads are reachable under both prefixes: `/files/*` directly, and
 * `/api/files/*` through the frontends' proxies.
 */
const PREFIXES = ['/api/files/', '/files/'] as const;

/**
 * The bucket key a file request is asking for, or null if it is not one.
 *
 * The key travels inside a URL, so a space or a comma in a filename arrives
 * percent-encoded — and six of the keys in production have one. Both the
 * signature and the bucket are keyed by the key itself: `/files/sign` mints a
 * token over the decoded key and R2 stores the decoded key, so a request for
 * `Kant%2C%20Immanuel.pdf` failed its signature check and never reached the
 * object it was entitled to.
 */
export function objectKeyFromPath(path: string): string | null {
	const prefix = PREFIXES.find((p) => path.startsWith(p));
	if (!prefix) return null;
	const raw = path.slice(prefix.length);
	try {
		return decodeURIComponent(raw);
	} catch {
		// A stray `%` is not an encoding — it is part of the key.
		return raw;
	}
}

/**
 * Whether a request carries a signature this deployment minted for the exact
 * object it is asking for.
 *
 * This is the only thing standing between the bucket and the public internet:
 * `/files/*` is served before session auth, because a signed URL is meant to
 * work in an <img> tag and a PDF viewer, which send no cookie. It once tested
 * that a token was *present* rather than valid, which let any value through —
 * hence the tests in packages/core/test/file-tokens.test.ts.
 */
export async function hasValidFileSignature(c: FileRequest): Promise<boolean> {
	const key = objectKeyFromPath(c.req.path);
	if (key === null) return false;

	const secret = c.env.FILE_SIGNING_SECRET;
	if (!secret) return false;

	return verifyFileToken({ token: c.req.query('token'), key, secret });
}
