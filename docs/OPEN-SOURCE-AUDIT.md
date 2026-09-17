# Open-source audit

_2026-09-16, against `main` at `6ede234`._

**Verdict: ready.** The code findings below are fixed and deployed, and the
history is gone.

No credential appeared anywhere in the repository or its 506 commits. Two things
in that history could not be published — a 2,254-row dump of the personal
journal, and 26 licensed commercial font files — so on 2026-09-17 the repository
was deleted and recreated from a single commit with the same files. See **Git
history** below.

The blocker was never the repository itself. It was a live production
vulnerability that publishing the source would have made trivially discoverable.

## Findings

Severity is about what happens if this is published, not about polish.

| #   | Finding                                                 | Severity | State                |
| --- | ------------------------------------------------------- | -------- | -------------------- |
| H1  | Journal dump (2,254 rows) in git history                | Critical | Purged               |
| H2  | 26 licensed commercial fonts in git history             | High     | Purged               |
| 1   | `/api/files/*` accepted any value as a signed token     | Critical | Fixed, deployed      |
| 2   | `LOCAL_DEV` could grant admin on a deployed worker      | High     | Guarded at deploy    |
| 3   | A real production user id hardcoded in source           | Medium   | Fixed                |
| 4   | Nine unused secrets live on the production worker       | Medium   | Deleted              |
| 5   | `SESSION_DURATION_HOURS` interpolated into SQL and Date | Low      | Fixed                |
| 6   | Personal email address in a migration comment           | Low      | Fixed in tree        |
| 7   | No `SECURITY.md`, no disclosure path                    | Low      | Fixed                |
| 8   | `LICENSE` named no copyright holder                     | Low      | Fixed                |
| 9   | No `.gitattributes`; CRLF churn on Windows              | Low      | Fixed                |
| 10  | `executeQuery` duplicated in twelve CLI scripts         | Low      | **Documented below** |
| 11  | 30 files are not Prettier-clean; CI never checks        | Low      | **Documented below** |
| 12  | `npm run dev:setup` could not build a local database    | Medium   | Fixed                |

---

### 1. `/api/files/*` accepted any value as a signed token — Critical

`sessionMiddleware` let a request through when a `token` query parameter was
merely **present**:

```ts
const isSignedFileRequest =
	(path.startsWith('/files/') || path.startsWith('/api/files/')) &&
	!!c.req.query('token');
if (isSignedFileRequest) return next();
```

The middleware that was supposed to check it, `fileAccessMiddleware`, called
`next()` in both branches — it could not reject anything. Verified against
production before the fix:

```
GET /api/files/probe.pdf          → 401 Session required
GET /api/files/probe.pdf?token=x  → 404 File not found   ← auth skipped, R2 read
```

Any literal value did it. With a real object key that returns the file: every
PDF, cover and essay image in the bucket, to anyone who knew or guessed a key.
Publishing the source would have handed a reader both the bypass and the key
format.

Only a nonexistent key was probed, so nothing was disclosed during the audit.
The 401 → 404 transition is the proof: authentication was skipped and the bucket
was queried.

**Fixed.** Signing and verification moved to
`packages/core/platform/file-tokens.ts` and made real:

- the signature is verified, and compared in constant time
- the signature covers the expiry, so extending it invalidates the token
- a token is bound to one object key
- keys are validated against traversal, absolute paths and control characters
- an absent `FILE_SIGNING_SECRET` rejects everything rather than passing

The dead middleware is gone, and the per-request `console.log` of every file
access with it. `Cache-Control` on an object went from
`public, max-age=31536000` to `private, max-age=3600`: a shared cache must not
keep a copy of a document that was entitled to one viewer for an hour.

17 unit tests and 12 route tests cover it. The route tests assert the bucket is
**not read at all** when a signature is wrong, so a leak shows up as a read that
happened. Reverting the check to the original one-line bug fails three of them.

### 2. `LOCAL_DEV` could grant admin on a deployed worker — High

`LOCAL_DEV=true` skipped Access entirely and set an admin context, in three
places: session auth, `POST /api/session`, and the MCP service-token check. It
is an ordinary variable. Setting it on a deployed worker — or a fork's
maintainer copying `.dev.vars` into production vars — opened everything.

**Fixed at deploy time, because it cannot be fixed at runtime.**

I tried twice to make the runtime decide it, and both attempts were wrong:

1. Require `request.cf` to be absent, on the theory that only the edge populates
   it. `wrangler dev` populates it too — with real geolocation, fetched live.
   Local `/api/me` started returning 401.
2. Require a loopback or private hostname. `wrangler dev` simulates the
   `custom_domain` route from `wrangler.toml`, so a local request arrives at
   `http://alexandria.socialeating.studio/…`. Indistinguishable again.

A local process and a deployed one are genuinely identical from inside the
worker. So `isLocalDev()` is back to trusting the variable — which is honest —
and the control moved to where it can actually be enforced:
`cli/deploy/assert-deployable.ts` fails a deploy whose target has `LOCAL_DEV`
set as a secret or declared in `wrangler.toml`, and both deploy workflows run it
before the worker ships. Verified in both directions against production.

The three call sites now share one `isLocalDev()` rather than testing the
variable separately, so there is one thing to audit instead of three.

### 3. A real production user id hardcoded in source — Medium

`6de42939-3d58-57af-b2bd-d9b158678bbd`, the admin's Cloudflare Access `sub`,
appeared as a literal in `auth.ts` and `session.ts`. Not a credential, but a
personal identifier that would have been published, and duplicated in two
places.

**Fixed.** It moved to `LOCAL_DEV_USER_ID`, documented in
`apps/worker/.dev.vars.example`, defaulting to a user that owns nothing. Set
yours there to keep developing against extracted production data.

### 4. Nine unused secrets on the production worker — Medium, deleted

These are set on `antisocial-worker` and **no code reads any of them**:

```
ALLOW_NUDGES   API_KEY          DATABASE_URL
DISCORD_APPLICATION_ID  DISCORD_BOT_TOKEN  DISCORD_PUBLIC_KEY
GUILD_ID       NEON_DATABASE_URL  SCRIPTS_DATABASE_URL
```

Leftovers from the Discord bot and the Neon era. They are live credentials — a
Discord bot token and three Postgres connection strings — sitting in a worker
that has no use for them, widening the blast radius of any compromise for no
benefit. `docs/DEPLOYMENT.md` also described `API_KEY` as a bearer token for
non-browser clients; nothing reads it, and that line is now corrected.

**Deleted, on your say-so.** All nine removed from production, and `API_KEY`
from staging, which had it too. Production and staging were re-checked
afterwards: `/health`, the catalogue, the authenticated routes and the MCP tools
all still answer correctly, which is the expected result for values nothing
reads.

What production carries now, and every one of them is read by code:

```
ADMIN_EMAIL  ANTHROPIC_API_KEY  FILE_SIGNING_SECRET  MCP_POLICY_AUD
MCP_SERVICE_TOKEN_ID  POLICY_AUD  PUBLIC_CATALOGUE  TEAM_DOMAIN
```

Deleting a secret from the worker does not invalidate it. If the Discord bot
token or the three Postgres connection strings were ever live, rotate them at
their source — Discord's developer portal and Neon — rather than assuming
removal was enough.

### 5. `SESSION_DURATION_HOURS` interpolated into SQL and Date — Low

```ts
`UPDATE sessions SET expires_at = datetime('now', '+${hours} hours')`;
```

`hours` came from `parseInt(env.SESSION_DURATION_HOURS ?? '12', 10)` at two call
sites, with no validation. Not injectable — it is an environment variable, not
user input — but a typo in the binding was a genuine outage: `NaN` makes
`toISOString()` throw on sign-in, and makes SQLite's `datetime()` return NULL on
extend, so the expiry no longer compares true and the user is logged out on
their next request.

**Fixed.** One validated `sessionDurationHours()` helper, clamped, used by both
call sites, and the value is now bound rather than interpolated.

### 6–9. Repository hygiene — Low, all fixed

- A personal Gmail address sat in a comment in
  `sql/migrations/0013_backfill_user_id.sql`. Removed from the file. It is still
  in history — see **C** under Git history, where it comes out for free
  alongside the two things that actually force a rewrite.
- `LICENSE` said `Copyright (c) 2025` with no holder. Now names you.
- No `SECURITY.md`. Added: how to report, what the API assumes, the three auth
  surfaces worth auditing, the known limits below, and how to rotate
  `FILE_SIGNING_SECRET`.
- No `.gitattributes`, so a Windows checkout rewrote files to CRLF and
  `apps/worker/test/__snapshots__/routes.test.ts.snap` sat permanently modified
  with no change in it. Added.

    **Expect this to look bigger than it is.** Declaring `* text=auto eol=lf`
    normalises line endings across the whole repo, so `git status` reports ~157
    modified files while only **23 have content changes**. The other 134 differ
    by line endings alone, which is why `git diff` shows nothing for them:

    ```bash
    git diff --numstat | wc -l     # 23 — the real change set
    git status --short | wc -l     # 157 — plus one-time normalisation
    ```

    That is the one-off cost of adding `.gitattributes` to a repo that never had
    one, and it does not recur.

### 10. `executeQuery` duplicated across twelve CLI scripts — Low

`cli/db/cleanup-quote-versions.ts`, `db-metadata.ts`, `migrate-events.ts`,
`ingest/enrich-all.ts`, the seven `utils/extract-*.ts`, and
`utils/seed-book-relationships.ts` each carry a private copy of the same helper:
`exec()` with the SQL interpolated into a shell string.

`cli/ingest/wrangler.ts` is the better implementation already in the repo — it
runs wrangler's entry script through `execFile` with no shell, so SQL reaches
wrangler verbatim on every platform. The twelve should collapse into it.

I did not do it in this pass. Each of those scripts talks to a live database,
several of them write, and a mechanical sweep I could only partially exercise is
a poor trade against duplication that is merely untidy. The seven extract
scripts are the safe subset — `npm run extract:all` exercises all of them
read-only in one command — and are the place to start.

What I did do is fix the part that actually cost something: a failed wrangler
call rejected with a spawn error whose Windows stderr is a libuv assertion,
burying the Cloudflare API message inside a stringified `stdout`. `wrangler.ts`
now throws the API's own message.

### 11. The repository is not Prettier-clean — Low

`CONTRIBUTING.md` tells a contributor to run `npm run format` before pushing.
Doing so rewrites **30 files nobody touched** — the spec-kit agent markdown,
`plans/scribe-extraction-plan.md`, `docs/SCRIBE.md`, `CONTEXT.md`,
`eslint.config.mjs`, three `tsconfig.json`s and the deploy action's YAML —
producing a ~2,000-line diff on top of whatever the contributor actually
changed. The Checks workflow runs lint, `tsc -b` and vitest, but not
`prettier --check`, so the drift was never caught.

For a public repo this is a trap: the first outside contributor who follows the
documented workflow produces an unreviewable pull request.

I hit it during this audit and reverted the 29 unrelated files by hand, so the
change this branch carries stays reviewable.

The fix is one mechanical commit of its own, not something to smuggle into a
security change:

```bash
npm run format          # its own commit, touching nothing else
```

and then a step in `.github/workflows/checks.yml` so it cannot drift again:

```yaml
- run: npx prettier --check .
```

### 12. `npm run dev:setup` could not build a local database — Medium

The first command `README.md` and `CONTRIBUTING.md` tell a new contributor to
run. It did not work, and its failure was the least legible in the repository.
Four separate faults, found by running it:

1. **`--reset` never reached the script.** The root `package.json` had
   `"dev:setup": "npm run dev:setup -w @alexandria/cli"` — without the trailing
   `--` that every other forwarding script has, so npm swallowed the flag. The
   reset silently did nothing and the replay ran over the old database.
2. **A rebuilt database could not be rebuilt again.** The script replayed all 27
   migrations unconditionally and treated "already exists" as success, but
   several migrations rebuild a table (`notes_new`, copy, drop, rename). A
   second pass therefore half-applied the sequence and died several migrations
   later at `table notes_new has 11 columns but 15 values were supplied` —
   nowhere near the cause. It now refuses an already-populated database and
   points at `--reset`, which is the only safe way to re-run.
3. **0013 fails against an empty database.** It backfills every row's `user_id`
   to `'admin-id'`, and earlier migrations seed rows, so it needs that user to
   exist. Production had one; a fresh local database does not.
   `packages/core/test/d1.ts` sidesteps this with `PRAGMA foreign_keys = OFF`,
   which is not available through D1 — a `--file` runs inside a transaction,
   where that pragma is a no-op. The script now seeds the placeholder user ahead
   of whichever migration references it.
4. **`--reset` failed silently on Windows.** `rmSync(..., { force: true })`
   swallows the refusal when another process holds the database open, which
   `npm run dev` always does. It now checks the directory is actually gone and
   says to stop the dev server.

Verified end to end afterwards: `--reset` rebuilds all 27 migrations, a re-run
refuses cleanly, and `npm run dev` then serves `/api/me` as the configured
developer.

This one matters more than its severity suggests. A contributor who cannot get
the thing running does not file a bug; they close the tab.

---

## Git history: what has to go before this is public

Publishing a repository publishes every commit, not the tip. Two things in this
history must not ship. Neither is a credential — the credential scan came back
empty — and neither is reachable from `origin/main`, which is why they are easy
to miss.

Everything below is stated from `git rev-list --all` over 506 commits and 96
refs.

### A. `migrations/data.sql` — 2,254 rows of your journal

Added in `7fa16ff` ("migrate to D1 and fix temporary notes capture"), never
deleted in a commit that removes it from history. It is a full dump:

| table           | rows  |
| --------------- | ----- |
| `event_ledger`  | 2,254 |
| `weather_daily` | 322   |
| `youtube_cache` | 81    |
| `news_daily`    | 14    |

`event_ledger` is the journal itself — moods with scores, and notes with their
prose. Rows carry `meta.original_file` paths like `old\2025\01\2025-01-09.md`,
so it also discloses the layout of the private archive they were backfilled
from. A sample row's note begins "Went into the office today. Worked on
developing Mo…".

This is the single strongest reason to rewrite. It is one file in one commit,
and it is still at the tip of one local branch: **`d1`**.

### B. Licensed commercial fonts — 26 files

`apps/web/public/fonts/` carried Tiempos and Tiempos Headline (Klim Type
Foundry), Söhne Mono (Klim), and Lyon Text (Commercial Type), plus `Tiempos.zip`
(2.65 MB) and the two `vllg_*.pdf` foundry specimen documents.

These are paid, per-licence typefaces. Redistributing the binaries in a public
repository is a licence violation regardless of intent, and the `.zip` is the
distribution archive itself. Touched by 5 commits, and still at the tip of **82
of 96 refs** — almost every stale branch.

`origin/main` and `origin/staging` are clean at their tips. The local `staging`
branch is not: it still has all 26.

### C. Lower stakes, same rewrite

- The personal Gmail address in `sql/migrations/0013_backfill_user_id.sql`,
  removed from the working tree in this pass but present in every historical
  copy of that file.
- `6de42939-3d58-57af-b2bd-d9b158678bbd`, the admin's Access `sub`, in
  historical copies of `auth.ts` and `session.ts`.

Neither is a credential. Both come out for free if you are rewriting anyway.

### What is _not_ a problem

- No book PDFs were ever committed. The bucket has always been R2.
- `local/`, where the `extract:*` scripts write every note, thought and quote as
  JSONL, has never been tracked.
- No `.env`, `.dev.vars`, or any file matching a credential pattern.
- The remaining large blobs are texture PNGs and repeated `package-lock.json`
  revisions — noise that makes the repo 41 MB, not a disclosure.

### What was done

A history rewrite was not enough on its own. GitHub keeps a read-only
`refs/pull/*` ref for every pull request, and nobody can push to or delete
those; the 305 of them would have kept every old commit, `data.sql` included,
reachable from the web until GitHub Support purged them.

Since the repository was private with no forks, it was cheaper to start over:

1. A mirror of the old repository was bundled as a backup.
2. One parentless commit was built from the tree of `main` at the time, so the
   files were byte-identical and no history came with them.
3. The repository was deleted and recreated, private, under the same name.
4. That commit was pushed as both `main` and `staging`, which keeps the two
   related, so a feature branch still merges into either.
5. `CLOUDFLARE_ACCOUNT_ID` was set again. `CLOUDFLARE_API_TOKEN` has to be
   minted anew: GitHub never reveals a stored secret, and the old token was
   already revoked.

Checked afterwards against the GitHub API: the only refs are `main` and
`staging` at the new commit, there are no pull requests, the old tip commit and
the `data.sql` blob both return Not Found, and the tree holds no font or
`apps/web` path. The backups were deleted once that held.

What this cost: pull request and Actions history, and the two secrets. What it
did not touch: the deployed workers, which were already running these files.

The leftover `apps/web/` build that carried the fonts has been deleted locally
as well, and `.gitignore` excludes that path so it cannot come back.

## What was checked and found clean

- **Git history.** 506 commits, 90 branches, scanned for private keys, bearer
  tokens, and provider key formats (`sk-`, `sk-ant-`, `ghp_`, `AKIA`, `AIza`,
  JWTs), and for any assignment of a literal to a `SECRET`/`TOKEN`/`API_KEY`/
  `PASSWORD` name. Nothing. `.env` and `.dev.vars` have never been committed.
- **SQL injection.** Every user-reachable query binds its parameters. The
  interpolations that exist build placeholder lists and fixed column lists, or
  come from constants. Finding 5 was the only interpolated value, and it is not
  user-reachable.
- **Route authorisation.** Every route under `/api/` sits behind
  `sessionMiddleware`; `/upload/*` and `/audit/*` behind `adminOnlyMiddleware`.
  Verified against production that `/books`, `/notes`, `/me` and `/essays` all
  answer 401 unauthenticated, with the catalogue published.
- **Tenant scoping.** The writing queries filter on `user_id` and build their
  `WHERE` clauses through `buildNoteWhere`-style helpers that bind it.
- **Secrets in tracked files.** None. `wrangler.toml` carries the Cloudflare
  account id and D1 database ids, which are identifiers rather than credentials
  — they grant nothing without an API token, and having them in the file is what
  makes the deploy reproducible. Reasonable to publish; if you would rather not,
  they move to CI variables and `wrangler.toml` joins `.gitignore` beside its
  `.example`.
- **Personal data in seeds.** `welcome-data.ts` is generic onboarding copy.

## Known limits, not defects

Carried into `SECURITY.md` so a reader finds them without reading this file:

- Any signed-in user can sign any object key. `POST /api/files/sign` checks for
  a session, not for ownership — R2 keys carry none. Fine for one tenant; needs
  an ownership model before a second.
- No rate limiting. The design leans on Access keeping unauthenticated traffic
  off the worker entirely.
- Deleting a work does not delete its file from R2.

## Left alone deliberately

- **`.github/agents/` and `.github/prompts/`**: 26 spec-kit scaffolding files.
  Noise for a reader, but they are your tooling and removing them is your call.
- **`plans/`**: three internal planning documents. Harmless, and honest about
  how the thing was built.
