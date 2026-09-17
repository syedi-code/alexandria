# alexandria

One backend. Hono on Cloudflare Workers, one D1, one R2, everything under
`/api/`. Two frontends call it — **stylus** (writing) and **scribe** (works) —
and neither holds data of its own.

## The one thing to understand first

The code splits into domains with one-way dependencies:

```text
packages/core/
├── works/          works, creators, documents, transcriptions, pages, media,
│                   page search, citation checks, the tools models read with
├── writing/        thoughts, notes, quotes, essays, moods, sleep
├── conversations/  Scribe's conversations, messages, page handles, citations
└── platform/       identity, sessions, audit, shared limits, SQL helpers

     writing/        MAY import  works/  and  platform/
     conversations/  MAY import  works/  and  platform/
     works/          may NOT import writing/ or conversations/
     writing/ and conversations/ never import each other
     platform/       imports none of them
```

Works is true regardless of who is reading it. Writing is one person's opinion
about it. That asymmetry is real, it is already in the data, and it is what lets
a second and third consumer exist.

**Nothing fails at runtime when you cross that line.** The only thing holding it
is `no-restricted-imports` in `eslint.config.mjs`, and
`packages/core/test/boundary.test.ts` proving the rule still fires. Treat both
as production code. If the rule is ever disabled "temporarily", the architecture
is over.

`@alexandria/core` has subpath exports — `/works`, `/writing`, `/conversations`,
`/platform` — so the direction of every import is visible in the import line.
The package root re-exports both domains, which is why works/ may not import it.

## Stack

TypeScript 5.9 · Hono 4.10 · Zod 3.25 · jose 6.1 · Cloudflare D1 (SQLite) and R2
· Vercel AI SDK 7 · MCP SDK · vitest.

## Commands

```bash
npm run dev             # wrangler dev, local
npm run test            # vitest
npm run lint            # eslint — includes the boundary rule
npm run deploy:prod     # wrangler deploy to production
npm run deploy:staging  # and to staging
npm run backup:prod     # dump production D1 before anything irreversible
npm run verify:tokens:prod   # every [[book:UUID]] in every essay still resolves
npm run pages:extract -- --env production   # PDF text layers into pages, row-budgeted
npm run pages:index -- --env production     # pages into the SEARCH database
```

Full list in `docs/COMMANDS.md`.

## Layout

```text
packages/core/works/     the catalogue and the Book facade
packages/core/writing/   notes, quotes, essays, and their joins onto works
packages/core/platform/  Env, auth types, sessions, users, audit, limits
packages/core/contract.ts  what a client needs to agree with the server
apps/worker/api/         routes, mirroring the same split
apps/worker/api/public.ts  the one route that answers without a session
apps/worker/public/      the catalogue page at /, served as a static asset
apps/worker/api/mcp/     the MCP server: works tools behind an Access service token
apps/worker/api/conversations/  Scribe: the model roster, the agent loop, chat routes
cli/                     setup, migration, backup, extraction tooling
sql/migrations/          applied in order; tests replay them to build a schema
sql/search/              schema of the SEARCH database (the page index)
```

## Things that will bite you

**Never remap a UUID.** Work ids live inside essay prose as `[[book:UUID]]`
tokens, not only in foreign-key columns. Remapping one silently corrupts an
essay written years ago, with nothing failing at write time.
`npm run verify:tokens:prod` is the check; run it before and after anything that
touches works.

**Columns are still called `book_id`.** `notes.book_id`, `quotes.book_id`,
`essay_references.entity_type = 'book'`. The tables were renamed; these were
not, because renaming them would mean rewriting the tokens. A column name is not
a contract.

**The D1 database is still `antisocial-media` and the R2 bucket is still
`antisocial-media-files`.** Cloudflare has no rename for either. "Renaming"
means migrating live data to change a string no user ever sees.

**`works/book-facade.ts` is the only place the old vocabulary lives.** It
projects `works` plus its primary document into the exact Book payload stylus
has always received. Add nothing to it; new code reads `works/` directly.

**The API is additive-only.** Two frontends, one publisher. Never remove a
field, never change a type, never narrow an enum. A breaking change is a planned
two-repo event, not a commit.

**Deletes are soft.** `works.deleted_at` hides a work from listings but it still
resolves by id, because essays cite it.

**Migrations and deploys are not independent.** See `docs/WORKS-MIGRATION.md`.

**Page search lives in a second D1 database, bound as `SEARCH`.** Backups are
`wrangler d1 export`, which refuses databases containing virtual tables, so the
FTS5 index cannot live in `DB`. It is derived from `pages` and never backed up;
`npm run pages:index` rebuilds it.

**`documents.r2_key` is not always a bucket key.** Rows carried over from
`books.pdf_url` hold `/files/books/...`, which stylus still receives. Go through
`documentObjectKey()`; never strip the prefix by hand.

**The free tier is a real constraint.** 100,000 rows written per day across the
whole account, 10 ms of CPU per worker request, 50 D1 queries per invocation.
Bulk writes go through the budgeted CLI, not the worker. See `docs/SCRIBE.md`.

**`/files/*` is served before session auth.** A signed URL has to work in an
`<img>` tag and a PDF viewer, neither of which sends a cookie, so the HMAC in
`?token=` is the only thing between R2 and the open internet. It shipped once
testing that a token was _present_ rather than valid, which served the whole
bucket to anyone. Verification lives in `platform/file-tokens.ts`; the route
tests assert the bucket is not even read when a signature is wrong. Never loosen
that path without a test that fails first.

**`LOCAL_DEV` cannot be checked at runtime, so it is checked at deploy time.**
It skips Access and grants an admin context. Nothing in a request tells a local
process from a deployed one — `wrangler dev` fills in `request.cf` with real
geolocation and simulates the custom domain — so both obvious guards are
useless. `npm run assert:deployable` fails a deploy whose target has it set, and
the deploy action runs it. Keep it in `.dev.vars` only.

**Model-facing text is product code.** Tool descriptions (`works/tools.ts`) and
instructions (`conversations/instructions.ts`, `mcp/server.ts`) decide how
models behave. Change them deliberately, and keep them consistent with each
other.

## Testing

There is no live D1 in tests. `packages/core/test/d1.ts` is a `D1Database`
implementation over `node:sqlite`, and the schema is built by replaying every
file in `sql/migrations/` — so a migration that drifts from the code fails in CI
rather than in production.

The characterisation tests over `getLibraryBooks` and `getBookDetail` are the
contract with stylus. If a snapshot moves, you have changed the payload a
shipped frontend depends on. That is sometimes right, but it is never
incidental.

## Style

Follow the surrounding code.

**Comments are brief, and only where the code is not immediately readable.** A
comment says why, or names a trap; it never narrates what the next line does. If
a comment is needed to explain what code does, rename or restructure the code
first.

<!-- MANUAL ADDITIONS START -->

## Git, Commit, and Merge Rules

- **Never commit, merge, or push unless the developer explicitly asks.** Stage
  nothing and open no PRs on your own initiative; finish the work and report it
  instead.
- **PR titles are prefixed by target:** `PROD: <summary>` for a PR into `main`,
  `STAGING: <summary>` for a PR into `staging`.
- **PR bodies stay empty.** The title carries the whole description.
- **Never merge `staging` into `main`.** The two are parallel deploy targets,
  not a promotion chain.
- **Always branch fresh off `main`** for each piece of work, then merge that one
  feature branch into **both** `staging` and `main` via separate PRs.
  <!-- MANUAL ADDITIONS END -->
