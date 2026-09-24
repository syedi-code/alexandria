# alexandria

One backend. Hono on Cloudflare Workers, one D1, one R2, everything under
`/api/`. Two frontends call it — **stylus** (writing) and **scribe** (works) —
and neither holds data of its own.

TypeScript 5.9 · Hono 4.10 · Zod 3.25 · jose 6.1 · D1 (SQLite) and R2 · AI SDK 7
· MCP SDK · vitest.

## The boundary, first

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

- Works is true whoever is reading. Writing is one person's opinion about it.
  That asymmetry is what lets a second and third consumer exist.
- **Nothing fails at runtime when you cross the line.** Only
  `no-restricted-imports` in `eslint.config.mjs` and
  `packages/core/test/boundary.test.ts` hold it. Both are production code. If
  the rule is ever disabled "temporarily", the architecture is over.
- Subpath exports (`/works`, `/writing`, `/conversations`, `/platform`) make the
  direction visible in the import line. The root re-exports both domains, which
  is why `works/` may not import it.

## Commands

```bash
npm run dev             # wrangler dev, local
npm run test            # vitest
npm run lint            # eslint — includes the boundary rule
npm run deploy:prod     # wrangler deploy to production
npm run deploy:staging  # and to staging
npm run backup:prod     # dump production D1 before anything irreversible
npm run verify:tokens:prod   # every [[book:UUID]] in every essay still resolves
npm run pages:extract -- --env production   # PDF text layers into pages
npm run pages:index -- --env production     # pages into the SEARCH database
```

Full list in `docs/COMMANDS.md`.

## Layout

```text
packages/core/works/     the catalogue and the Book facade
packages/core/writing/   notes, quotes, essays, and their joins onto works
packages/core/platform/  Env, auth types, sessions, users, audit, limits
packages/core/contract.ts  what a client must agree with the server
apps/worker/api/         routes, mirroring the same split
apps/worker/api/public.ts  the one route that answers without a session
apps/worker/public/      the catalogue page at /, a static asset
apps/worker/api/mcp/     the MCP mount; the server itself is alexandria-mcp
apps/worker/api/conversations/  Scribe: model roster, agent loop, chat routes
cli/                     setup, migration, backup, extraction tooling
sql/migrations/          applied in order; tests replay them to build a schema
sql/search/              schema of the SEARCH database (the page index)
```

## Data — things that will bite you

- **Never remap a UUID.** Work ids live inside essay prose as `[[book:UUID]]`,
  not only in FK columns. Remapping corrupts an essay silently, with nothing
  failing at write time. `npm run verify:tokens:prod` before and after.
- **Columns are still `book_id`** (`notes`, `quotes`,
  `essay_references.entity_type = 'book'`). Renaming them means rewriting the
  tokens. A column name is not a contract.
- **The D1 is still `antisocial-media`, the bucket still
  `antisocial-media-files`.** Cloudflare has no rename; "renaming" means
  migrating live data to change a string no user sees.
- **`works/book-facade.ts` is the only place the old vocabulary lives.** Add
  nothing to it; new code reads `works/` directly.
- **The API is additive-only.** Never remove a field, change a type or narrow an
  enum. A breaking change is a planned two-repo event, not a commit.
- **Deletes are soft** — `works.deleted_at` still resolves by id, because essays
  cite it.
- **Migrations and deploys are not independent.** See `docs/WORKS-MIGRATION.md`.
- **Page search is a second D1, bound `SEARCH`.** `wrangler d1 export` refuses
  virtual tables, so FTS5 cannot live in `DB`. Derived, never backed up;
  `npm run pages:index` rebuilds it.
- **`documents.r2_key` is not always a bucket key** — rows from `books.pdf_url`
  hold `/files/books/...`. Go through `documentObjectKey()`; never strip by
  hand.
- **The free tier is a real constraint:** 100k rows written a day, 10ms CPU a
  request, 50 D1 queries an invocation. Bulk writes go through the budgeted CLI.

## Access and money

- **`/files/*` is served before session auth.** A signed URL must work in an
  `<img>` and a PDF viewer, so the HMAC in `?token=` is all that stands between
  R2 and the internet. It once tested that a token was _present_ rather than
  valid, serving the whole bucket. `platform/file-tokens.ts`; tests assert the
  bucket is not read on a bad signature. Never loosen without a failing test.
- **A reader never gets the library, only the pages they were cited.** The whole
  file and any page on request are the admin's; readers go through `/cited/...`
  (`isCitedForReader`), scans on Paid only. **A route serving "any page, one at
  a time" serves the whole book to a loop** — tie every new page route to a
  citation and test the refusal.
- **A guest reaches an allow list, never a deny list.** `GUEST_ROUTES` in
  `auth.ts`; `guestBoundary()` answers 403 `ACCOUNT_REQUIRED` to everything
  else, so a route added later is closed until someone opens it. Guest questions
  count for ever. Sign-in moves their rows in one batch; `adoptGuest` refuses
  anything that is not a guest. Off until `TURNSTILE_SECRET` is set.
- **The per-address guest cap is not a cost control.** Turnstile is the defence;
  a guest costs ~$0.06. At five it turned away the sixth person on any campus or
  carrier network, invisibly. It is 100; `GUESTS_PER_DAY` is the real bound;
  both refusals log.
- **An allowance is a week, and the number is a row, not a constant.**
  `TURNS_PER_WEEK` is the default; `allowanceFor()` reads `settings` over it, so
  it turns without a deploy. Free is _derived_ from Paid by
  `FREE_SHARE_OF_PAID`. A bad row falls back rather than throws — this runs on
  every turn.
- **`billing_week` is stored, not derived** (`strftime` in a WHERE cannot use an
  index). ISO weeks, UTC. `billing_month` stays for the spend report.
- **Money goes through the webhook, and the webhook trusts only Stripe.**
  Signature verified before anything is read; each subscription re-fetched
  rather than read off the event; `users.plan` recomputed from `subscriptions`,
  never set. One customer per reader, never moved. Tests fake only
  `billing/client.ts` and verify with the real `constructEventAsync`.
- **Some secrets name one environment and must never be synced.** `POLICY_AUD`
  is per-deployment; `npm run sync:secrets` pushes `.env` to **production**, so
  one run would point production at staging and fail every sign-in.
  `PER_ENVIRONMENT` refuses those, and `CLOUDFLARE_API_TOKEN` is blacklisted — a
  worker secret is readable by every route, and that token can rewrite the
  Access policies in front of it. `POLICY_AUD` is a comma-separated list.
- **`LOCAL_DEV` is checked at deploy time, not runtime.** Nothing in a request
  tells local from deployed (`wrangler dev` fills in real `request.cf`).
  `npm run assert:deployable` fails a deploy that has it set. `.dev.vars` only.

## Models and citations

- **Model-facing text is product code.** Tool descriptions (`works/tools.ts`)
  and instructions (`conversations/instructions.ts`, `mcp/server.ts`) decide
  behaviour. Change deliberately, keep them consistent.
- **A model can leave the citation grammar altogether** — it has written
  OpenAI's `【P5†…】` instead of `<cite>`, load-dependent, in an answer that
  looked normal while two claims were silently uncheckable.
  `normaliseCitationShapes()` translates before `verifyAnswer` and before
  saving. **Never widen `CITATION`** — `FOREIGN_SHAPES` is a table in front of
  the one grammar scribe must agree with.
- **`citationTrouble()`** catches an answer naming a handle no citation claimed,
  or reading pages and citing none. A bare handle cannot be translated, so
  `streamTurn` asks once more via `citeAgain()` — **once only**, then it reaches
  the reader as it is.
- **An instruction a model half-keeps is not a rule.** Quoted words were written
  twice on 29 of 137 citations, unmoved by three syntax revisions and not
  reproducible on demand. `collapseQuotedDuplicates()` removes it before saving
  — what is saved is what the next turn reads back, and doubling teaches
  doubling. Only the run immediately against the cite.

## Testing

- No live D1. `packages/core/test/d1.ts` is a `D1Database` over `node:sqlite`,
  and the schema replays every file in `sql/migrations/` — so a migration that
  drifts from the code fails in CI, not production.
- The characterisation tests over `getLibraryBooks` and `getBookDetail` are the
  contract with stylus. A moved snapshot means a changed payload a shipped
  frontend depends on. Sometimes right, never incidental.

## Style

- Follow the surrounding code.
- **Comments are brief, and only where the code is not readable.** A comment
  says why, or names a trap; never what the next line does.

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
