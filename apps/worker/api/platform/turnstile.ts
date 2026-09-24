const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Whether Cloudflare says this Turnstile token was earned by a person, just
 * now, on our site. Checked on the server every time: the widget only hands
 * the page a token, and a token the page could forge would stop nothing.
 *
 * A Turnstile outage fails closed — no guest — because the alternative is a
 * door anyone can walk through, one paid question at a time. A visitor who
 * meets it can still sign in.
 */
export async function passedTurnstile(
	secret: string,
	token: string,
	address: string | undefined,
	fetcher: typeof fetch = fetch
): Promise<boolean> {
	if (!token || token.length > 2048) return false;
	const form = new FormData();
	form.append('secret', secret);
	form.append('response', token);
	if (address) form.append('remoteip', address);
	try {
		const response = await fetcher(SITEVERIFY, {
			method: 'POST',
			body: form,
		});
		if (!response.ok) {
			console.error(`[guest] Turnstile answered ${response.status}`);
			return false;
		}
		const outcome = (await response.json()) as {
			'success'?: boolean;
			'error-codes'?: string[];
		};
		if (outcome.success === true) return true;

		// Cloudflare says *why* it refused, and the reasons are not alike: a
		// bad token is a visitor to turn away, a bad secret is a deployment
		// that turns away everyone and says nothing. This threw the codes away,
		// so a secret that was never right looked exactly like a quiet site.
		const codes = outcome['error-codes'] ?? [];
		const ours = codes.some((code) =>
			[
				'invalid-input-secret',
				'missing-input-secret',
				'bad-request',
			].includes(code)
		);
		console[ours ? 'error' : 'warn'](
			`[guest] Turnstile refused: ${codes.join(', ') || 'no reason given'}${
				ours
					? ' — this is our secret, not the visitor. No guest can be made.'
					: ''
			}`
		);
		return false;
	} catch (error) {
		console.error('[guest] Turnstile could not be reached', error);
		return false;
	}
}
