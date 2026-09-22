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
		if (!response.ok) return false;
		const outcome = (await response.json()) as { success?: boolean };
		return outcome.success === true;
	} catch (error) {
		console.error('[guest] Turnstile could not be reached', error);
		return false;
	}
}
