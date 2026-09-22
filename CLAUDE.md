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
apps/worker/api/mcp/     the MCP server mount; the server itself is alexandria-mcp
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

**A reader never gets the library, only the pages they were cited.** The whole
file (`/files/sign`, `/files/*` on a session) and any page of text on request
(`/documents/:id/pages`) are the admin's. Readers go through `/cited/...`, which
serves a page only within one page of a citation in their own conversations
(`isCitedForReader`), and the scan only on Paid. A route that serves "any page,
one at a time" serves the whole book to a loop; tie every new page-serving route
to a citation, and test the refusal.

**A guest reaches an allow list, never a deny list.** A visitor may ask three
questions before signing in (scribe#38): `POST /session/guest` makes a `users`
row with `is_guest = 1` and an ordinary session, only past Turnstile and under a
daily cap per address (stored as an HMAC, never the address). `guestBoundary()`
then answers 403 `ACCOUNT_REQUIRED` to every route not in `GUEST_ROUTES` in
`auth.ts`, so a route added later is closed to guests until someone opens it on
purpose. A guest's questions count for ever, not a month. Signing in
(`POST /session` with a guest cookie and a JWT) moves the guest's conversations
and ledger rows to the account in one batch and deletes the guest; `adoptGuest`
refuses anything that is not a guest. `POLICY_AUD` is a comma-separated list,
one audience per `/login/<idp>` Access app. Off until `TURNSTILE_SECRET` is set.

**Money goes through the webhook, and the webhook trusts only Stripe.**
`api/billing/`. The signature is verified before anything is read; then each
subscription is fetched from Stripe rather than read off the event, so order and
duplicates cannot matter, and `users.plan` is recomputed from `subscriptions`
rather than set. A customer is tied to one reader, once, and never moved. Tests
fake Stripe's API (`billing/client.ts` is the only module they replace) but sign
every event with Stripe's own helper and verify it with the real
`constructEventAsync`. `npm run stripe:setup` makes the product, price, portal
and endpoint.

**`LOCAL_DEV` cannot be checked at runtime, so it is checked at deploy time.**
It skips Access and grants an admin context. Nothing in a request tells a local
process from a deployed one — `wrangler dev` fills in `request.cf` with real
geolocation and simulates the custom domain — so both obvious guards are
useless. `npm run assert:deployable` fails a deploy whose target has it set, and
the deploy action runs it. Keep it in `.dev.vars` only.

**A model can leave the citation grammar altogether.** On 20 September a heavy
turn came back with no citations at all: the model had written every one in
OpenAI's own file-search notation —
`【P5†Inorganic matter is the maternal bosom】` — rather than in ours. Nothing
parsed, so nothing was verified, no `data-citations` was written, and the reader
was shown the brackets. The handles and the quoted words were right the whole
time; only the punctuation was foreign.

It is reproducible and it is load-dependent. On a light turn the model writes
`<cite>` every time; on the turn that read eight ranges and the index it wrote
the foreign shape in two runs out of two, once mixed in with nine correct cites
in the same answer — an answer that looks entirely normal while two of its
claims are silently uncheckable.

`normaliseCitationShapes()` translates the shape into ours before anything reads
it, in `verifyAnswer` and again before the answer is saved. Regenerating the
answer was the other option and it is the wrong trade: a second pass over that
context costs minutes of a model that is already slow, to change a delimiter on
a citation that would have verified. The marker hangs off its word the way a
footnote number does, so the space a quotation needs and a footnote number does
not is part of the translation.

It is deliberately **not** a widening of `CITATION`. There is one citation
grammar and scribe has to agree with it forever; `FOREIGN_SHAPES` is a table of
foreign spellings in front of it, which the next shape can be added to without
touching the grammar or the other repo.

What is still missing is the other half: an answer carrying a `P`-handle that no
citation claimed is an answer whose citation we failed to read, and it should
fail the turn rather than reach a reader looking complete.

**An instruction a model half-keeps is not a rule.** The instructions ask for
the quoted words to be written once, inside the `<cite>`. Across production the
model wrote them twice — the quotation in its prose, then the same words again
in the citation — on 29 of 137 citations, and the rate did not move when the
citation syntax was changed under it. It is not reliably reproducible either:
the mode fires on about one answer in three, holds for a whole answer once it
starts, and would not fire at all across twelve replays of the exact context
that produced it. So a revised instruction cannot be shown to work, and the
duplication is taken out deterministically instead —
`collapseQuotedDuplicates()` in `conversations/citations.ts`, applied to the
answer before it is saved. What is saved is what the next turn reads back, and
an answer that doubled its quotations taught the turn after it to do the same.

Only a quoted run immediately against the citation is collapsed — a quotation,
one space, a cite of the same words, which is the shape every instance in
production took. A quotation that merely appears again elsewhere in the answer
is left alone: pairing quotations to distant citations by their shared words is
what scribe's `anchorsFor()` did, and it paired 42 of 92.

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
