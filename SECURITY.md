# Security

## Reporting

Open a
[private security advisory](https://github.com/syedi-code/alexandria/security/advisories/new).
Please do not open a public issue for a vulnerability.

There is no bounty and no SLA. Reports are read and answered as time allows.

## What the API assumes

alexandria is a single-tenant deployment behind Cloudflare Access. Every route
under `/api/` requires a session, minted from an Access JWT by
`POST /api/session`. There is no anonymous surface and no registration.

Three things carry more weight than the rest, and are the places to look first:

**`/files/*` is served before session auth.** A signed URL has to work in an
`<img>` tag and a PDF viewer, neither of which sends a cookie, so the HMAC in
`?token=` is the only thing between the R2 bucket and the open internet. It is
verified in `packages/core/platform/file-tokens.ts`, and
`apps/worker/test/files.test.ts` asserts the bucket is not even read when the
signature is wrong. A token grants one object key for one hour, and nothing
else.

**`LOCAL_DEV` stands in for Access on a developer's machine**, and skipping
Access means an admin context. Nothing in a request distinguishes a local
process from a deployed one: `wrangler dev` populates `request.cf` with real
geolocation and simulates the custom domain from `wrangler.toml`, so both
obvious runtime checks fail. The variable is trusted at runtime and guarded
where it can be — `npm run assert:deployable` fails a deploy whose target has
`LOCAL_DEV` set as a secret or declared in `wrangler.toml`, and both deploy
workflows run it before shipping. It belongs in `.dev.vars` and nowhere else.

**MCP is a second front door.** `/api/mcp` is not session-authenticated. It sits
behind its own Access application and verifies both the JWT's audience and the
service token's client id, so a token issued for a different application cannot
use it. The server it mounts lives in
[alexandria-mcp](https://github.com/syedi-code/alexandria-mcp), which has its
own `SECURITY.md` for what the tools themselves expose.

## Known limits

These are understood and accepted for a single-tenant deployment. They would
each need work before a second person used it:

- **Any signed-in user can sign any object key.** `POST /api/files/sign`
  requires a session but does not check that the key belongs to the caller. R2
  keys carry no ownership, so enforcing it needs an ownership model that does
  not exist yet. This is the one that matters most if the Access policy is ever
  widened: `GET /api/catalogue` publishes the library's ids without a session,
  and `GET /api/books/:id` turns one into an object key, so a signed-in reader
  can fetch any document in the bucket in full.
- **No rate limiting, and no spend cap.** The worker relies on Cloudflare Access
  to keep unauthenticated traffic off it entirely. Nothing bounds an
  authenticated one: `POST /api/conversations/:id/chat` runs an agent loop of up
  to `MAX_STEPS` steps on the deployment's own provider keys, and a turn costs
  tens of thousands of input tokens because page text is re-sent at every step.
  `npm run spend:prod` reports what has been spent, per reader; it does not
  limit it.
- **`/api/*` is reachable without Access.** Both frontends bypass their Access
  application for `/api/*` so their Pages Function can proxy it, which means the
  session endpoint and everything behind it face the open internet directly.
  Access is the front door for people, not for the API.
- **Deletes are soft.** `works.deleted_at` hides a row from listings; it still
  resolves by id, because essays cite it. Deleting a work does not remove its
  file from R2.
- **Sessions are not cleaned up reliably.** `cleanupExpiredSessions` is
  fire-and-forget on sign-in, and expired rows outnumber live ones by a wide
  margin in production.

## What tenant isolation covers

Every private entity — notes, quotes, essays, thoughts, threads, links, media,
sleep, conversations and messages — is scoped by `user_id` in SQL, not by a
check in the route. Works and creators are deliberately shared: the catalogue is
the same library whoever is reading it, and only an admin may change it.

The seam between those two is `packages/core/writing/enrichment.ts`, which joins
the shared catalogue to private writing. It shipped unscoped, so
`GET /api/books/:id/detail` returned one reader's quotes, notes and essays to
any other — over ids that `GET /api/catalogue` gives out with no session at all.
The second-reader tests in
`packages/core/test/catalogue.characterisation.test.ts` are what keep that
fixed; treat them as production code.

## Handling a leaked file-signing secret

`FILE_SIGNING_SECRET` is the only secret whose compromise exposes content rather
than access. Rotating it invalidates every outstanding signed URL, which is the
intended effect:

```bash
cd apps/worker
npx wrangler secret put FILE_SIGNING_SECRET                 # production
npx wrangler secret put FILE_SIGNING_SECRET --env staging
```

Clients re-sign on their next request, so the only visible effect is that
already-open PDFs stop loading until reloaded.
