# alexandria / stylus / scribe — migration plan

**Status:** Shipped 2026-09-15. Three repos, both databases migrated, both
workers and both frontends deployed. §14 records what was built; §15 records
the rollout, including what went wrong.
**Last updated:** 2026-09-15
**Rewritten from the ground up** for the three-repo architecture. Supersedes
every earlier draft. There is no supersession archaeology in this document:
what is written here is what is decided.

> The filename is now a misnomer — this is not an extraction to scribe, it is a
> split of one repo into three. Kept for link stability.

> **Provenance of cited files.** `plans/multi-tenant.md` is referenced in §3.1
> and hazard §5.8 as the origin of the shared-catalogue design and the
> never-built `book_requests` table. It has been **deleted from the working
> tree** but is intact in git history — recover it with
> `git show HEAD:plans/multi-tenant.md`. Verified: it does contain the
> `book_requests` schema. `plans/threads.md` is in the same state.
>
> **This file is gitignored by default** (`.gitignore:41` ignores `plans/`). A
> negation for this one file has been added so it can be committed. **Commit
> it** — until then it is a single untracked copy that `git clean -fdx` would
> destroy.

---

## 0. Start here — for an agent picking this up cold

**Phases 1–4 are done.** Read §14 first; it says what was built, where the
plan was refined on contact, and what is left for a human. The rest of this
document is the reasoning behind it, which is still worth having.

1. Read §1 and §2, then `CONTEXT.md`. §2 is the whole argument in table form.
2. Check §2 "Open". It currently reads **None**. If someone has added one back,
   ask before writing code — open questions here change the shape of the work,
   not just its details.
3. Start at **Phase 1** (§6). Do not create a repo. Do not rename anything. Do
   not touch Cloudflare.
4. The first commit worth making is characterisation tests over
   `getLibraryBooks` and `getBookDetail`, because hazard §5.2 means you are
   otherwise refactoring blind.
5. **Hazard §5.1 is absolute: never remap a UUID.**

---

## 1. What this is

One repo becomes three. One backend, two frontends.

| Repo | What it is | Stack |
| --- | --- | --- |
| **alexandria** | The backend. One D1, one R2, everything under `/api/`. | Hono on Workers, TypeScript |
| **stylus** | The writing app. The existing frontend, renamed. | Vue 3 |
| **scribe** | The works app. New, with a new design system. | TBD, greenfield |

Inside alexandria the code splits into two modules with a one-way dependency:

```text
alexandria/src/
├── works/      works, creators, documents, transcriptions, pages, media
└── writing/    thoughts, notes, quotes, essays, moods, sleep

     writing/  MAY import  works/
     works/    may NOT import  writing/
```

That direction is the entire architecture. Everything else is detail.

### Why not two backends

An earlier draft made scribe a full vertical slice with its own database and its
own API — Self-Contained Systems. That design is sound, and it is priced for a
**team**: its value is letting separate groups deploy without coordinating.

One developer gets none of that benefit and pays all of the cost, because the
boundary would sit directly across a join made in nearly every query that
matters. `getLibraryBooks` joins works to quotes, notes and essay references in
a single statement. Across two services that becomes a service binding, a
composition layer, and forwarded caller identity on write paths. In one backend
it stays a `LEFT JOIN`.

What the split was protecting — the conceptual seam, the Work model, the ability
to point a second frontend at the same data — all survive in one backend. What
it cost — a second auth realm, a duplicated CLI, a second D1, a second R2, a
second Cloudflare project — all disappears.

### What three repos buy

Release cadence. scribe ships without touching stylus; stylus ships without
touching alexandria. What three repos do **not** buy is runtime decoupling —
both frontends still call one live backend, so a breaking API change breaks both
at once no matter how the repos are arranged. That is what D27 exists for.

---

## 2. Decisions

### Settled

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | **The seam is Works vs Writing, and it is one-way.** Writing points at Works. Works never points back and never imports from it. | Works is true regardless of who is reading; Writing is one person's opinion about it. That asymmetry is real, already exists in the data, and survives a second and third consumer. |
| D2 | **One backend — `alexandria`. One D1, one R2, everything under `/api/`.** Not two services. | See §1. A network boundary at this seam costs a composition layer and buys nothing until there is a team. |
| D3 | **Three repos: `alexandria`, `stylus`, `scribe`.** | Repos decouple release cadence, which is the thing actually wanted. They do not decouple runtime — see D27. |
| D4 | **The seam is enforced by a lint rule, not by a network boundary.** `works/**` may not import `writing/**`; the reverse is allowed. | The only thing preventing the seam from rotting. Under two services you *cannot* accidentally join across it; under one backend you can, and eventually will, and nothing fails at runtime when you do. ~20 lines of config is the entire price of keeping a future split possible. **Not optional decoration.** |
| D5 | **The modules are named `works/` and `writing/`.** | `Work` is already the entity name (D6) and is the standard top-level term in Open Library, Crossref and FRBR — it matches the internal model and the outside world at once. `writing` over-claims nothing: a Thought is writing as much as an Essay is. Neither collides with an existing `_Avoid_` entry in `CONTEXT.md`. |
| D6 | **The core entity is `Work`, with `kind` in {book, article, lecture, podcast, film, …}.** Book is one kind, and the only fully-modelled one on day one. | Cited answers need resolvable citation targets, which free-text creator/title strings are not. Adding a discriminator later, with rows already in the table, is far worse than adding it now. |
| D7 | **Work is a strict superset of Book** — same field names and types, plus `kind`. `GET /books` is a thin facade projecting `works WHERE kind='book'` into today's exact Book payload. | Lets stylus keep working through the migration with near-zero churn. Under one backend this facade is a view over the same database, not an HTTP endpoint — it costs almost nothing. |
| D8 | **stylus keeps its columns named `book_id`** while they hold Work ids. | A column name is not a contract. Renaming them would mean rewriting `[[book:UUID]]` tokens embedded in essay prose, which hazard §5.1 forbids. Widening the UI to non-book sources is deferred, not blocked. |
| D9 | **Repo genesis: rename this repo to `alexandria` in place; `git filter-repo` `apps/web` out as `stylus`; `scribe` starts empty.** | alexandria keeps all 224 commits for free, and GitHub's rename redirects old URLs and preserves issues, PRs and stars. Only one extraction has to go right, and it is the half whose history is most self-contained. scribe inherits nothing because a new design system has nothing to inherit. |
| D10 | **Extend the existing Cloudflare Access application to cover the new hostnames.** Do not create a wildcard app. Auth is otherwise exactly what exists today. | There was never a second auth realm to build — only one the two-backend design would have forced us to *split*. Not splitting it is the entire saving. Verified live: one app already covers three hostnames, so adding two more leaves `POLICY_AUD` unchanged — **no secret rotation, no redeploy, no code change**. A wildcard app would mint a new `aud` and force exactly that rotation. `router.ts:182` sets `role = email === ADMIN_EMAIL ? 'admin' : 'member'`; `auth.ts:170` is the single admin gate. Both unchanged. See §8. |
| D11 | **Each frontend keeps its own Pages Function proxying `/api/*` to alexandria.** | Same-origin in the browser: no CORS, no cross-site cookie work, no second API client. `apps/web/functions/api/[[catchall]].ts` already does exactly this in production, lifting the CF Access JWT out of `CF_Authorization` into a `cf-access-jwt-assertion` header. scribe gets a copy. Proven code, not a plan. |
| D12 | **stylus keeps full catalogue management permanently.** `EditBookModal`, `BookManager`, `AuthorManager`, `EditAuthorModal` and `LibraryMediaSection` (1,102 lines) are **not** deleted. | Never amputate the working app. stylus is the thing that exists and functions today; removing its ability to add a work in service of a frontend that does not exist yet trades certainty for hope. It writes through alexandria's API like any other client. |
| D13 | **scribe builds its own catalogue admin later, in its own design system. No shared UI kit.** | The consequence of D12 is two independently-maintained admin UIs against one Works API — a real ongoing cost, accepted deliberately (hazard §5.5). Sharing components instead would anchor scribe to Vue and to stylus's layout assumptions, which is precisely what a new design system exists to escape. Share technical code, not business logic. |
| D14 | **alexandria owns extracted text. The Python pipeline is a stateless client that POSTs results in.** | Text is a property of the Work, not of the tool that derived it. Lets the pipeline — and its deprecated agent framework — be replaced without a data migration. |
| D15 | **Extraction schema is `works → documents → transcriptions → pages`**, with `works.primary_document_id` and `documents.current_transcription_id` for deterministic reads. | A transcription keyed only to a Work cannot say *which* PDF's page 47 — and philosophy means translations. `books.pdf_page_offset` already proves pagination belongs to the file, not the work. The `transcriptions` level is what makes multi-model comparison possible at all. |
| D16 | **Page images are rendered once during extraction into R2** (`pages.image_key`), not generated on demand. Page text stays in D1 so it is searchable. | The Workers runtime has no native PDF renderer. ~1MB text per 400-page work; ~100 works is ~100MB per transcription set, so three model variants is ~300MB against D1's 10GB ceiling. Comfortable, but keep the R2-fallback path in mind if the catalogue grows an order of magnitude. |
| D17 | **Chat runs in alexandria** (Worker, streaming SSE, tool = local D1 query). **Extraction stays in the Python service** (long-running, exceeds Worker limits). Two runtimes, by design. | Chat's tool queries local data; running it in Python makes every tool call an HTTP round-trip for rows already in hand. Workers stream well; Python already does the long job. |
| D18 | **Hand-rolled verified attribution, not a provider's native citations. Model-agnostic on purpose.** The model proposes `{claim, work_id, page_no, quote}`; the harness verifies the quote against `pages.text` before rendering. See §11. | This is the product's epistemic claim, not an implementation detail: an answer is shown only if its source was checked. A robust verifier is what makes a cheap model safe, which is what lets models be swapped freely for cost. |
| D19 | **Chat is admin-only on day one, behind a policy seam.** One `resolveChatPolicy(authContext)` returns `{model, tokenBudget}`; today it returns the good model and no ceiling for admin, and refuses everyone else. | Reuses `auth.ts:170` verbatim — zero new tables, zero cost exposure. The seam is the point: widening to members with a budget and a cheaper model is later a change *inside one function*, not a refactor. And per D18 a cheap model behind a strong verifier is not a degraded product, so "members get the budget model" is the design paying off rather than a compromise. |
| D20 | **Shared code: the param table and size limits ship as data in `GET /api/me`; the parser machinery is copied into stylus.** | The two halves of `essay-tokens.ts` have different natures. `EMBED_PARAM_SPECS` and `MAX_LENGTHS` are pure JSON with no functions — they serialise, so they can have exactly one home, on the server. The regex/parse/validate/serialise machinery must run in the browser on every keystroke for live preview, so it must be shipped JavaScript. **The part that changes lives in one place; the part that is duplicated is the part that is already frozen** (untouched since 2026-05-12). Full reasoning in §12. |
| D21 | **Soft delete: `works.deleted_at`.** Deleted works are hidden from lists but still resolve by id. | Under one database the FKs work again, so this is no longer a distributed-systems problem — it is ordinary hygiene. It still matters because a Work id is embedded in essay prose (§5.1): hard-deleting a Work silently corrupts an essay written years ago. Merging duplicate creators needs the same care — rewrite to the survivor's id, never delete the loser. |
| D22 | **Rename touches visible names only.** The D1 database stays `antisocial-media` and the R2 bucket stays `antisocial-media-files`. Full inventory in §13. | Cloudflare has no rename for D1 or R2 — "renaming" means migrating live data to change a string no user ever sees. That risks the only irreplaceable thing in the system to buy nothing. |
| D23 | **Genealogies are a separate future app** consuming alexandria's API. Entirely out of scope — do not implement any of it here. | Keeps the admin-only write model intact, which is the only thing keeping auth an evening rather than a month. |
| D24 | **Carve the modules in place first. Split the repos after. Rename last.** | Splitting costs the same whenever it happens, so doing it early buys nothing and makes every cross-boundary change two commits in two repos during the most volatile window. A rename touching every file makes every `git blame` and every merge fight you — so it goes last, when nothing is in flight. |
| D25 | **All 23 `.claude/skills/` move to `~/.claude/skills/`.** No repo commits them. | Audited: every one is generic engineering workflow (`grilling`, `tdd`, `code-review`, `domain-modeling`, `handoff`, `wayfinder`, …). There are no project-specific skills to split. Personal workflow belongs to the user, not the repo. |
| D26 | **Staging survives as it is for alexandria and stylus; scribe runs production-only until it needs otherwise.** | The staging worker, D1, R2 and Pages project already exist and cost nothing to keep. A staging copy for scribe would go stale immediately against ~100 low-churn works. `backup-d1` plus D1 Time Travel (30-day point-in-time restore) covers the destructive-migration risk. Revisit when scribe needs phone testing against a non-prod API — it is one `d1 create` and a deploy. |
| D27 | **API changes are additive-only.** Never remove a field, never change a field's type, never narrow an enum. Add the new thing and let the old consumer lag. | This is the discipline that substitutes for the runtime decoupling three repos do *not* provide (D3). With one publisher and two consumers it is cheap, and it is the difference between "stylus deploys whenever" and "stylus deploys in lockstep." A breaking change is not forbidden — it becomes a deliberate, planned two-repo event rather than something stumbled into. |
| D28 | **The `@`-picker is a frontend concern. The chat endpoint accepts caller-supplied context blocks.** `POST /chat` takes `context: [{id, label, text, kind}]`; `kind:"page"` alexandria resolves itself, `kind:"supplied"` it treats as opaque text it quotes and hands back by id. | Under one backend, `@`-referencing your own notes needs no plumbing — alexandria has both halves. The `supplied` hatch stays in the contract for genuinely external context, and the discipline stays because it keeps the chat endpoint from growing a dependency on every caller's vocabulary. §11 records why a supplied citation is a **weaker claim** than a page citation. |

### Open

**None.**

Three things are deliberately deferred, not open: scribe's own catalogue admin
(D13), member access to chat (D19), and widening stylus's UI to non-book
sources (D8).

---

## 3. Current-state inventory

### 3.1 Tables that belong to `works/`

| Table | Notes |
| --- | --- |
| `books` | has `user_id` (provenance only — reads are never user-scoped) |
| `authors` | same; `name` is globally UNIQUE |
| `book_media` | `user_id NOT NULL`, FK `book_id ON DELETE CASCADE` |

Per `plans/multi-tenant.md` the library is already designed as a **shared,
admin-curated reference layer** — any authenticated user reads, only admin
writes. This is the strongest existing evidence that the seam is real rather
than invented for this migration.

### 3.2 Pointers from `writing/` into `works/`

| Pointer | Shape |
| --- | --- |
| `notes.book_id` | nullable FK + `page` |
| `quotes.book_id` | nullable FK + `page` |
| `connections` | polymorphic edges, `a_type`/`b_type` in {author, book, …} |
| `essay_references.entity_id` | `entity_type` in {book, book_cover, quote, image} |
| essay tokens | `[[book:UUID]]` / `[[book_cover:UUID]]` **inline in essay prose** |

Work and creator ids are embedded in **essay body text**, not only in FK
columns. Any id remapping would require rewriting prose. **Preserve all UUIDs at
every migration step.** Non-negotiable.

Heaviest consumers of `connections` for creator edges: `NotesPage.vue:294`,
`QuoteCard.vue:94`, `EditQuoteModal.vue:83`, `ThreadViewQuote.vue:57`,
`PresentationViewNote.vue:153`, `ThreadDetail.vue:204`, `EditNoteModal.vue:55`.

### 3.3 Backend code

| File | Lines | Destination |
| --- | --- | --- |
| `packages/core/database/books.ts` | 128 | `works/` |
| `packages/core/database/authors.ts` | 127 | `works/` |
| `packages/core/database/book-media.ts` | 107 | `works/` |
| `packages/core/database/library.ts` | 297 | **SPLIT** — see below |
| `packages/core/database/schema.ts` L75–161 | ~90 | `works/` (Book/Author/BookMedia zod) |
| `apps/worker/api/router.ts` L302–796 | ~495 | `works/` routes |
| `apps/worker/api/router.ts` L797–944 | ~148 | `works/` routes (`/upload/pdf`, `/upload/cover`, `/upload/book-media`) |
| `apps/worker/api/router.ts` L1080–1140 | ~60 | **stays shared** — `/files/sign` + `/files/*` serves works assets *and* essay images. One bucket, one signer, one owner. |
| `apps/worker/api/auth.ts` | 175 | unchanged |
| everything else in `packages/core/database/` | — | `writing/` |

**`library.ts` is the entanglement hotspot and the reason Phase 1 exists.**
`getLibraryBooks` returns `quote_count`, `note_count`, `citation_count`,
`media_count` and `last_activity_at`; `getBookDetail` returns the book's quotes,
notes, essays and "related books via essay co-citation." Only `media_count` is
a works concern. Split into:

- `works/catalogue.ts` — works / creators / media only
- `writing/enrichment.ts` — the quote / note / essay joins

`enrichment.ts` lives on the **writing** side, which is what preserves D1's
direction. It may import from `works/`; the reverse would fail the lint rule.

### 3.4 Frontend

`apps/web/src/components/library/` — 13 components, ~2,500 lines. **Under D12
none of this is deleted.** It moves to the stylus repo wholesale.

Catalogue admin, kept (1,102 lines): `LibraryMediaSection` (313),
`EditBookModal` (281), `AuthorManager` (207), `BookManager` (161),
`EditAuthorModal` (140).

Browse and citation UX, kept (~1,949 lines): `LibraryPage` (451),
`LibraryDetailPane` (338), `SourceSelector` (263), `AuthorSelector` (257),
`BookLinePicker` (231), `BookSelector` (181), `AuthorPopover` (128), plus
`lib/bookAttribution.ts` (112).

Plus `lib/api.ts` L666–1010 (~345 lines of catalogue calls),
`composables/useSourceLibrary.ts` (104 — module-singleton cache shared with the
essay editor), `composables/useBookHue.ts` (38).

**Production is already same-origin, via a proxy that already exists.**
`lib/api.ts:261` sets `baseURL: VITE_API_URL || '/api'`, and `VITE_API_URL` is a
local-dev bypass only. In production the browser hits `/api/*` on the Pages
origin and `functions/api/[[catchall]].ts` proxies to the worker, lifting the CF
Access JWT out of `CF_Authorization` into a `cf-access-jwt-assertion` header and
stripping CORS on the way back. **This is why D11 costs nothing.**

### 3.5 CLI

`cli/` is 4,449 lines, hardcoded to one database at `cli/db/execute-sql.ts:32`.
**Under D2 it stays whole in alexandria and is never duplicated** — one of the
larger savings against the two-backend design, which required either
parameterising all of it or duplicating ~1,000 lines.

`cli/setup/` (1,273 lines) stays directly reusable: `create-d1-resources.ts`
(266) and `create-r2-resources.ts` (235) create resources *and write the ids back
into `wrangler.toml`*; plus `apply-schema.ts` (200), `set-up-environment.ts`
(352), `sync-secrets.ts` (92).

### 3.6 Infra

One D1 (`antisocial-media`), one R2 (`antisocial-media-files`) holding PDFs,
covers, work media **and** essay images together — which under D2 is correct
rather than a problem. Auth is CF Access JWT → `__session` cookie on the worker
origin.

### 3.7 History

224 commits total. 96 touch `apps/web`; the union of web-or-worker is 104 —
meaning the two halves have been shipping in the **same commits** nearly every
time. Relevant to D9: see hazard §5.4.

---

## 4. Size estimate

| Area | Lines touched | Phase |
| --- | --- | --- |
| Characterisation tests (net new) | ~250 | 1 |
| Module carve — moves, not rewrites | ~660 moved, ~300 split | 1 |
| Worker route reorganisation | ~700 moved | 1 |
| Lint rule + config | ~20 | 1 |
| Work model schema + data migration | ~400 | 2 |
| `/books` facade | ~80 | 2 |
| `/api/me` payload + stylus consumption | ~120 | 3 |
| Repo split mechanics | ~200 | 4 |
| Rename (visible surface only) | ~60 | 4 |
| **Total to reach three repos** | **~2,800** | |
| scribe | greenfield | 5 |
| The LM half | greenfield | 6 |

Compare the two-backend design's ~5,400 plus an unresolved CLI duplication
decision. The frontend, which was the bigger half there, is barely touched here:
D12 keeps it whole and the repo split moves it rather than rewriting it.

---

## 5. Known hazards

1. **UUIDs must be preserved.** Work ids live inside essay prose as
   `[[book:UUID]]` tokens. Remapping means rewriting prose. Migrate ids as-is,
   at every step, forever. The one rule with no exceptions.
2. **There is no test suite.** `CLAUDE.md` advertises `npm test`, but no `test`
   script exists in any workspace, there are zero `*.test.ts` / `*.spec.ts`
   files, and there is no vitest config. The seam is being carved blind. **Add
   characterisation tests over `getLibraryBooks` and `getBookDetail` before
   splitting `library.ts`** so the enrichment split is provably
   behaviour-preserving. This is Phase 1's first task for a reason.
3. **The lint rule is the only thing holding the seam.** Under two services the
   boundary enforced itself. Here, one `import` from `works/` into `writing/`
   silently destroys the property that makes a future split possible, and
   nothing fails at runtime. If the rule is ever disabled "temporarily," the
   architecture is over. Treat it as production code.
4. **`filter-repo` will produce commit messages describing absent diffs.** Since
   ~90% of `apps/web` commits also touched the backend (§3.7), stylus's
   extracted history will contain messages referring to worker changes that are
   not in the repo. Harmless but confusing. Note it in stylus's README.
5. **Two admin UIs against one Works API.** The accepted cost of D12 + D13. When
   the Works API changes, two frontends need updating and one of them is not the
   one you are working in. D27 is the mitigation; without it this becomes the
   main source of breakage.
6. **`connections` is polymorphic and spans the seam.** `author`↔`note`,
   `author`↔`quote`, `book`↔`note` edges live in writing's table but reference
   works entities. They stay in `writing/` holding opaque ids. The lint rule
   permits this — writing may reference works.
7. **`authors.name` is globally UNIQUE.** Fine for one curated catalogue.
   Revisit if the genealogy app (D23) ever writes creators.
8. **`book_requests` was designed but never built.** `plans/multi-tenant.md`
   §1.1 specifies a table letting members request works the admin then adds. No
   table, no code. D12 keeps stylus's admin UI so this is no longer urgent —
   but members still have no way to ask for a work.
9. **Dead-ish code rides along into stylus.** `CONTEXT.md` marks **Thread** as
   retired and superseded by Essay, but the tab is still wired
   (`AppHeader.vue:24`) and ~750 lines still ship (`threads.ts` 401 core + 348
   worker + 4 components). Unrelated to this migration; worth its own decision.
10. **`CLAUDE.md` is already stale and will get worse.** It documents a
    `backend/ frontend/ tests/` structure that does not exist and advertises a
    non-existent `npm test`. Rewrite it in Phase 4, once per repo.
11. **`journal-bot` is a real deployed worker, not just a stale doc reference.**
    `docs/COMMANDS.md:110` names it as production; `wrangler.toml` says
    `antisocial-worker`. Verified: both exist on the account, and `journal-bot`
    has no custom domain — so it is almost certainly dead. Confirm and delete
    during Phase 4, and fix the doc.
12. **The Works contract is frozen right now** (untouched since 2026-04-29),
    which is what makes this cheap. It will be violently unstable *during*
    Phase 2. That is the argument for D24 — carve and migrate while commits are
    still atomic, split repos after.

---

## 6. Phases

### Phase 1 — carve the seam in place

Still one repo, still named `antisocial-media`. Nothing deploys differently.

- [x] Add vitest. Write characterisation tests over `getLibraryBooks` and
      `getBookDetail` capturing current output for a representative set —
      including a work with zero quotes, one with co-citations, and one with
      `pdf_url IS NULL` (hazard §5.2)
- [x] Create `packages/core/works/` and `packages/core/writing/`
- [x] Move `books.ts`, `authors.ts`, `book-media.ts` → `works/`
- [x] Split `library.ts` → `works/catalogue.ts` + `writing/enrichment.ts`
- [x] Move the remaining `database/*.ts` modules → `writing/`
- [x] Split `router.ts` into `works/routes.ts` + `writing/routes.ts`, mounted
      via `app.route()`. `/files/*` stays shared (§3.3)
- [x] Add the lint rule (D4) and verify it fails on a deliberate violation
- [x] Audit: nothing in `works/` references a `writing/` table, in SQL or TS
- [x] Characterisation tests still pass

**Exit criterion:** the lint rule passes, and deleting `writing/` would leave
`works/` compiling.

### Phase 2 — the Work model

- [x] Schema: `works`, `documents`, `transcriptions`, `pages`, `creators`,
      `work_media` (§10)
- [x] Back up first. D1 Time Travel is the safety net (D26), but take an
      explicit `backup-d1` too
- [x] **Pre-flight review before running the migration.** This is the only
      irreversible step in the plan, so it is worth independent scrutiny from
      several angles, each of which fails differently: null/default handling
      (a book with no `pdf_url`, no `originally_published`, no `author_id`);
      `pdf_page_offset` semantics moving from book to document; `authors.name`
      being globally UNIQUE when creators merge; orphaned `book_media` and
      cascade behaviour; essay tokens pointing at rows the migration drops.
      **This is the one place in the whole plan where a multi-agent workflow
      genuinely earns its cost** — see the note below
- [x] Data migration **preserving every UUID** — each `books` row becomes one
      `works` row plus one `documents` row carrying its `pdf_url` and
      `pdf_page_offset`; `authors` → `creators`; `book_media` → `work_media`
- [x] Build the `/books` facade (D7)
- [x] **Verify every `[[book:UUID]]` token in every essay still resolves.**
      This is **one SQL query** — extract tokens from `essays.content` with a
      regex and `LEFT JOIN works` — not a fan-out. Deterministic and
      exhaustive; an agent sweep would be slower *and* able to miss a row.
      Do not spot-check. This is the check that matters most in the plan
- [x] stylus untouched throughout — it still calls `/books` and still gets the
      payload it got yesterday

### Phase 3 — prepare the split

- [x] Add `embed_specs` and `limits` to the `GET /api/me` payload (D20, §12)
- [x] Change stylus to read them from that response instead of importing from
      `@antisocial/core`, with the shipped copy as a fallback until the fetch
      resolves
- [x] Reduce `@antisocial/core` imports in `apps/web` to the parser machinery
      alone — currently 16 import sites across 13 files (§12)

**Exit criterion:** `apps/web` imports exactly one thing from the backend
package, and that one thing is frozen code.

### Phase 4 — split and rename

- [x] `pip install git-filter-repo` (not bundled with git; not currently
      installed on this machine)
- [x] `git filter-repo --path apps/web` → new `stylus` repo
- [x] Copy the parser machinery into `stylus/src/lib/` with an origin comment
- [x] Repoint stylus's `functions/api/[[catchall]].ts` at alexandria (D11)
- [x] Verify stylus builds and deploys standalone
- [x] Delete `apps/web` from this repo
- [x] Rename the GitHub repo → `alexandria` (redirects preserve old URLs)
- [x] Rename the worker, the Pages projects, and the Access app **display name**;
      **leave D1 and R2 alone** (D22, §13)
- [x] Create the empty `scribe` repo
- [x] Add `stylus.` and `scribe.socialeating.studio` to the **existing** Access
      app; keep `anti.socialeating.studio` and `journal.ibrahimsyed.io` alive (§8)
- [x] Confirm `journal-bot` is dead, then delete it (hazard §5.11)
- [x] Rewrite `CLAUDE.md` in each repo (hazard §5.10)

### Phase 5 — scribe

- [ ] Design system
- [ ] Copy `functions/api/[[catchall]].ts` from stylus (D11)
- [ ] Catalogue browse, then catalogue admin (D13)
- [ ] Drag-and-drop PDF ingestion UI

### Phase 6 — the LM half

- [ ] Replace the deprecated agent framework in the Python pipeline
- [ ] Stand it up behind `Authorization: Bearer` against `ALEXANDRIA_API_KEY`
      (§7), deployed to a container host — not Workers; it is long-running
- [ ] Transcription storage and page-image rendering (D15, D16)
- [ ] FTS5 index over `pages.text`
- [ ] Chat endpoint behind `resolveChatPolicy()` (D19)
- [ ] The verification harness (§11)

### On multi-agent workflows

Assessed 2026-09-15: **this plan does not need one, with a single exception.**
The codebase fits in one context (26 files in `packages/core` plus a 1,187-line
router), and Phase 1's moves are interdependent — imports change together — so
parallel agents would conflict rather than help.

The exception is the **Phase 2 pre-flight** above, which is a
"be-confident-before-committing" case: diverse lenses on an irreversible data
migration beat one careful pass. Everything else is either deterministic
scripting (the token check) or small enough to do inline (the Phase 1 audit of
what else touches the works tables — ten greps and 26 files).

---

## 7. Auth

Auth is **what already exists**, extended by two small things. It is not an
identity system and it is not a month of work.

| Client | Mechanism | Work required |
| --- | --- | --- |
| stylus → alexandria | CF Access JWT → `__session` cookie, via the Pages Function proxy | **Zero.** Already works in production. Do not touch it. |
| scribe → alexandria | Identical — same Access app, second hostname, copied proxy | Cloudflare config plus copying one file |
| Python pipeline → alexandria | `Authorization: Bearer <secret>` vs `c.env.ALEXANDRIA_API_KEY` | ~15 lines of Hono middleware. The primitive already exists (`API_KEY` in `wrangler.example.toml`) |
| Chat | `resolveChatPolicy(authContext)` → `{model, tokenBudget}` | ~10 lines. Today: admin gets the good model unmetered, everyone else is refused (D19) |

Roles are unchanged: `router.ts:182` sets `role = email === ADMIN_EMAIL ?
'admin' : 'member'`, and `auth.ts:170` is the single admin gate. Any user who
clears CF Access is a `member` with a private `writing/` scope; `works/` is
readable by all and writable by admin only.

The month-long version of auth — accounts, signup, refresh rotation, rate
limiting, abuse — begins only when *other people contribute*, which is the
genealogy app (D23). Separate app, separate decision. Do not let its shadow
price this project.

---

## 8. Mechanics

### `git filter-repo`

Extracts a subdirectory into its own repo **keeping the commits that touched
it**, with real authors and dates. Not bundled with git — `pip install
git-filter-repo`.

```bash
git clone antisocial-media stylus && cd stylus
git filter-repo --path apps/web
```

The alternative (`mkdir` + `cp -r`) throws away every "why is this like this" in
the history. See hazard §5.4 for the one wart it leaves.

### Cloudflare inventory — verified live 2026-09-15

Account `71f096d9f762dc997a51b7492bd1474d`. Everything below was read from the
Cloudflare API or probed directly, not assumed.

| Resource | Production | Staging |
| --- | --- | --- |
| Worker | `antisocial-worker` → custom domain **`api.ibrahimsyed.io`** (verified) | `antisocial-worker-staging` (no custom domain) |
| D1 | `antisocial-media` (`069d3dc5-2f80-4333-be34-d3b1cf455af7`) | `antisocial-media-staging` (`ba85f6dc-715a-48de-bb9f-49d3907fbf79`) |
| R2 | `antisocial-media-files` | `antisocial-media-files-staging` |
| Pages | `antisocial-media` — custom domains `anti.socialeating.studio`, `journal.ibrahimsyed.io`, `antisocial-media.pages.dev` | same project |
| Zones | `socialeating.studio` (`8593e09af517363b811d7f71a8c9ea3f`), `ibrahimsyed.io` (`13517bebfca7375ae9478ceaea6e908f`) — both active | — |
| Secrets | `API_KEY`, `TEAM_DOMAIN`, `POLICY_AUD`, `ADMIN_EMAIL` (worker); `WORKER_URL` (Pages) | same |

**Stray worker:** `journal-bot` exists and is deployed, with no custom domain.
Almost certainly dead — `docs/COMMANDS.md:110` still names it as production
(hazard §5.11). Confirm and delete during Phase 4.

### The Access application (verified)

There is **exactly one** Access application, and it already covers three
hostnames:

| Field | Value |
| --- | --- |
| Team domain (`TEAM_DOMAIN`) | `socialeating.cloudflareaccess.com` |
| `aud` (`POLICY_AUD`) | `2cdd7f0d0d1c6f7f6e6e912b7f45dbc6f65d5085ac2139fd4597371afd140945` |
| Hostnames | `anti.socialeating.studio`, `journal.ibrahimsyed.io`, `antisocial-media.pages.dev` |

**Extend this application. Do not create a wildcard one.** A new app over
`*.socialeating.studio` would mint a **new `aud`**, which means rotating the
`POLICY_AUD` worker secret and redeploying — risk bought for nothing. Adding a
fourth and fifth hostname to the existing app leaves `POLICY_AUD` unchanged, so
**no secret rotation and no code change**. It is the same operation that already
took this app from one hostname to three.

**The worker is deliberately NOT behind Access.** `api.ibrahimsyed.io/api/me`
returns `401` from application code, not a `302` to the Access login — the
worker validates the CF Access JWT itself against `TEAM_DOMAIN` / `POLICY_AUD`
(`auth.ts:31-36`). Keep it that way: fronting the worker with Access would break
the Python pipeline's bearer-token path (§7).

### Registering the three hostnames

| Hostname | Kind | Steps |
| --- | --- | --- |
| `stylus.socialeating.studio` | Pages custom domain | 1. Add as a custom domain on the Pages project (auto-creates the CNAME). 2. Add to the existing Access app. |
| `scribe.socialeating.studio` | Pages custom domain | Same two steps, against scribe's own Pages project. |
| `alexandria.socialeating.studio` | Worker custom domain | `wrangler.toml` route below, then deploy. **No Access app entry.** |

```toml
[[routes]]
pattern = "alexandria.socialeating.studio"
custom_domain = true
```

**Keep the old hostnames.** A Pages project holds multiple custom domains at no
cost, so leave `anti.socialeating.studio` and `journal.ibrahimsyed.io` pointing
at stylus after the rename. Bookmarks survive, and nothing is gained by
breaking them.

### Token scope — what an agent can and cannot do here

The `CLOUDFLARE_API_TOKEN` in `.env` (id `ab8d5b57cb8fd88760e2db273c39b89e`)
reads zones, Pages projects and Workers, and is **denied on DNS records and
Zero Trust / Access** (`Authentication error` on both). Consequences:

- The account-level `access/apps` endpoint returns an **empty list rather than a
  403** under this token. That empty result is a permissions artifact, not
  truth — do not conclude from it that no Access app exists. Verify by probing a
  live hostname and reading the `aud` out of the 302 redirect.
- Both Access steps and any manual DNS write need the dashboard or a broader
  token. Everything else in this plan is scriptable.

### Local tooling state — verified 2026-09-15

What an agent on this machine can and cannot do without asking the user:

| Tool | State | Consequence |
| --- | --- | --- |
| `gh` CLI | **Authenticated** as `syedi-code`, scopes `repo`, `read:org`, `gist`, `admin:public_key` | Creating the `scribe` repo and renaming this one to `alexandria` are **scriptable**. No `delete_repo` scope, which this plan never needs. |
| `pip` | Present (Python 3.11) | `pip install git-filter-repo` is scriptable. |
| `git filter-repo` | **Not installed** | Install it at the start of Phase 4, not before. |
| `wrangler` | **Not logged in** (`whoami` → "Not logged in") | Deploys need either `wrangler login` (interactive browser OAuth — human only) or `CLOUDFLARE_API_TOKEN` in the environment. |
| `CLOUDFLARE_API_TOKEN` in `.env` | Read-scoped (see above) | Sufficient to *inspect*. Not sufficient to create DNS records or edit Access. |

**The single unblock:** one Cloudflare API token with `DNS:Edit`, `Access:Edit`,
`Pages:Edit` and `Workers:Edit` on account `71f096d9f762dc997a51b7492bd1474d`
makes every remaining step in Phase 4 scriptable. Without it, two dashboard jobs
stay manual: adding the two hostnames to the Access application, and the initial
Pages custom-domain entries.

Nothing in Phases 1–3 needs any of this. They are pure code in this repo.

### What can actually be renamed

| Resource | Renameable | Cost if you insist |
| --- | --- | --- |
| GitHub repo | **Yes** — redirects old URLs, keeps issues/PRs/stars | Free |
| Worker | No — deploying under a new `name` creates a new worker | Deploy new, move custom domain, delete old. Brief route flip. Low risk. |
| Pages project | No — new project means a new `*.pages.dev` | Recreate, repoint the Access policy. Low risk. |
| **D1 database** | **No.** `wrangler d1` has no rename | Create new, export/import, repoint `database_id`. **Real risk with live data.** |
| **R2 bucket** | **No.** `wrangler r2 bucket` has no rename | Create new, copy every object, reissue signed URLs. **Real risk.** |
| Access app | Display name editable in the dashboard; `POLICY_AUD` stays stable | Cheap — and this is what fixes "sign in to antisocial-media" |
| Secrets | Just re-`put` | Free |

**Per D22: rename the repos, the worker, the Pages projects and the Access app
display name. Leave D1 and R2 alone.**

### Domains

Target shape:

```text
alexandria.socialeating.studio   the worker
scribe.socialeating.studio       Pages
stylus.socialeating.studio       Pages
```

Registration steps and the Access-app decision are above — extend the existing
application rather than creating a wildcard one (D10).

alexandria does not strictly need a public hostname — both frontends reach it
through their own Pages Function proxy (D11), which can use a service binding
instead of a public fetch. Give it one anyway if you want future first-party
clients; keep it behind the same Access policy.

The existing custom domain `api.ibrahimsyed.io` currently points at the worker.
Decide at Phase 4 whether to move it or retire it — nothing in this plan depends
on the answer.

### Standing up scribe's Pages project

Prerequisite (human, once): `CLOUDFLARE_API_TOKEN` exported, **or** `wrangler
login` already run — it is an interactive OAuth browser flow an agent cannot
complete.

```bash
npx wrangler pages project create scribe
npx wrangler pages deploy dist --project-name scribe
```

**The one step wrangler cannot do:** add scribe's hostname to the Cloudflare
Access application. Dashboard, or the Access API with an Access-scoped token.

Everything else here is scriptable in one agent session, because there is no new
D1, no new R2 and no new worker to create — which is the whole point of D2.

---

## 9. Vocabulary

`CONTEXT.md` at the repo root is the glossary and is the authority on terms. It
was updated alongside this rewrite:

- **Works** and **Writing** replaced Catalogue and Corpus under "The boundary"
- **Work**, **Book** and **Creator** moved out of the corpus section into their
  own "Works" heading, and **Book** is now defined as *a Work whose kind is
  `book`* rather than as a sibling of Work
- The **Genealogy** section is marked *(future separate app)* per D23

At repo-split time `CONTEXT.md` splits too: alexandria keeps the full glossary,
stylus keeps the Writing terms, scribe keeps the Works terms. A
`CONTEXT-MAP.md` is not needed — one context per repo.

---

## 10. Works schema (D6, D14–D16)

```text
works                  the abstract work
  id, kind, title, creator, creator_id, originally_published,
  isbn, description, cover_key, primary_document_id, deleted_at

documents              a concrete file
  id, work_id, r2_key, label ("Kaufmann trans., 1967"),
  page_offset, page_count, is_primary, current_transcription_id

transcriptions         one extraction run
  id, document_id, model, prompt_version, status,
  started_at, finished_at, cost

pages                  one page of one run
  transcription_id, page_no, text, image_key

creators               (today's `authors`)
  id, name, bio, born, died

work_media             (today's `book_media`)
  id, work_id, r2_key, kind, caption, sort_order
```

`GET /books` (D7) projects `works WHERE kind='book' AND deleted_at IS NULL`
joined through `primary_document_id` into today's exact Book payload —
including `pdf_url` and `pdf_page_offset`, which now come from `documents`.

**Migration:** each `books` row becomes one `works` row (**same UUID** — §5.1)
plus one `documents` row carrying its `pdf_url` and `pdf_page_offset`.
`authors` → `creators`, same UUIDs. `book_media` → `work_media`, same UUIDs.

---

## 11. The verification harness (D18)

The product claim is **epistemic**: an answer is rendered only if its source was
checked against the actual document. The model is not trusted to be right, only
to be *checkable*. That is what makes model-agnosticism a cost lever rather than
a compromise — a strong verifier makes a budget model safe, which is exactly
what D19 leans on when chat opens to members.

### Contract

Per claim: `{claim, work_id, page_no, quote}`. A page number alone is not
checkable; a **verbatim span** is. For a supplied block (D28) the shape is
`{claim, block_id, quote}` — no page, because the caller owns the pagination.

### Verify

1. Look up `pages.text` for `(current_transcription_id, page_no)`.
2. **Normalise both sides first** — fold ligatures (`ﬁ`, `ﬂ`), strip
   hyphen-at-linebreak, collapse whitespace, normalise smart quotes and
   non-breaking spaces. Raw exact-match against PDF-derived text rejects correct
   citations at a high rate. This step is not optional.
3. Match. On success, render the claim with `pages.image_key` as the visual
   citation.

### Repair before rejecting

The common real failure is a **true quote on the wrong page**, not a fabricated
one. If the quote fails at `page_no`, search it across every page of the work —
found elsewhere means correct the page number and proceed. Only a quote found
*nowhere* is a hallucination, and only that gets rejected.

### Supplied blocks are a weaker claim (D28)

A `kind:"page"` block cites a **page image in R2** — a picture of the actual
document. That is the epistemic showpiece. A `kind:"supplied"` block has no
image, and verification only proves *the model did not fabricate the quote from
the text it was handed* — it cannot vouch for the source, because the caller
supplied it. Both are worth having; they are **not the same strength of claim**
and the UI must not render them identically.

### Consequence for D15

Verification accuracy is bounded by transcription accuracy — bad OCR rejects
good citations. So **citation verification rate is a quality metric for a
transcription.** The `transcriptions` level is not only for comparing extraction
models; it is the evaluation substrate for the chat half of the system.

### Retrieval

SQLite **FTS5** over `pages.text` (supported in D1) before reaching for
embeddings.

---

## 12. Shared code between alexandria and stylus (D20)

### What is actually shared

Two files, and both are `writing/` domain — **scribe needs none of it.**

| File | Lines | Nature |
| --- | --- | --- |
| `database/limits.ts` | ~18 | **Data.** `MAX_LENGTHS` — notes 3,000, essays 20,000, titles 500, … |
| `database/essay-tokens.ts` | 279 | **Half data, half code.** See below. |

Today `apps/web` imports these at 16 sites across 13 files. Note the frontend
uses **no Zod at all** — there is no wire-schema sync problem here, which is a
correction to an earlier assumption.

### Why it has to be shared at all

You type `[[book:9f2a… bg=light]]` inside an essay. Two programs read that same
line:

- **The server**, on save, to work out which works the essay cites — that is
  what fills `essay_references`, and it is why a work can say "cited in 3
  essays."
- **The browser**, on view and on every keystroke, to render it and to show live
  preview while you type.

In one repo they import the same file and cannot disagree. Across repos they
can.

### The split

`essay-tokens.ts` contains two different kinds of thing.

**The param table (`EMBED_PARAM_SPECS`) is pure data.** Verified: strings,
numbers and arrays, no functions. It says a `quote` may carry `size` (int,
12–48, default 24); a `book` may carry `author` (enum show/hide) and `size`
(12–64); an `image` may carry `bg` (enum dark/light/none) and `caption`
(string). **This is the part that changes** — adding `bg=sepia` is adding one
row here.

→ **It ships as data in `GET /api/me`** (`router.ts:268`, which stylus already
calls on load). One copy, on the server. Drift becomes impossible rather than
merely detected. `MAX_LENGTHS` rides along the same way.

**The machinery is code.** `TOKEN_RE`, `parseEssayToken`, `parseEssayTokens`,
`parseAttrTail`, `validateParams` and the serialiser. It must run in the browser
on every keystroke for live preview — you cannot make a network request per
character — so it must be shipped JavaScript.

→ **It is copied into stylus**, with a header comment naming alexandria as the
origin. Acceptable because it is the frozen half: three changes, all in a
two-week burst, last touched **2026-05-12**, untouched in the four months since,
and nothing in this plan goes near essays.

> The part that changes lives in one place on the server.
> The part that is duplicated is the part that is already frozen.

### Other shared-ish things, resolved

- `lib/bookAttribution.ts` (112 lines, pure, zero deps) — stylus's only. scribe
  will want its own formatting in its own design system (D13).
- `useSourceLibrary.ts` — stylus's client cache for the works API. Stays.
- `/files/sign` + `/files/*` — one implementation, one bucket, one owner:
  alexandria. Not forked.

---

## 13. Rename inventory — every `antisocial` string (D22)

Visible names only. D1 stays `antisocial-media`; R2 stays
`antisocial-media-files`.

### Tier 1 — visible in the browser (must change)

| Location | Current |
| --- | --- |
| `apps/web/index.html:7` | `<title>antisocial-media</title>` |
| `apps/web/src/components/shared/AppHeader.vue:93` | banner text `antisocial` |
| `apps/web/src/components/essays/EssaySlideExportFrame.vue:51` | `antisocial.media` — **burned into every exported essay slide image** |
| `apps/web/public/icon.svg` | favicon — check for a wordmark |

### Tier 2 — visible but NOT in this repo (dashboard only)

| Surface | Where it lives |
| --- | --- |
| **The CF Access login page** ("sign in to antisocial-media") | Access application **name**. Dashboard or Access API. Not a code change — and this is the one you noticed. |
| `*.pages.dev` hostname | Pages project name |
| Worker `*.workers.dev` hostname | Worker name |

### Tier 3 — localStorage keys (change = silent data loss)

`useDraft.ts:3`, `useThoughtDraft.ts:3`, `useEssayDraft.ts:3-16`,
`CaptureForm.vue:10`, `QuoteCaptureForm.vue:11` — keys `antisocial-draft-note`,
`antisocial-capture-draft`, `antisocial-quote-draft`, `antisocial-thought-draft`,
`antisocial-essay-draft`, `-tags`, and two `LEGACY_` keys.

**Renaming these silently discards any unsaved draft in a live browser.**
Recommend: leave them. Invisible to users, zero risk.

### Tier 4 — coupled to the Pages project name

`apps/worker/server.ts:14-15` hardcodes CORS origins
`https://antisocial-media.pages.dev` and
`https://staging.antisocial-media.pages.dev`. **If the Pages project is renamed
this must change in the same deploy** or the staging frontend breaks. Under D11
both frontends are same-origin in production, so this only affects direct worker
access — but it will bite during the Phase 4 cutover.

### Tier 5 — docs and config (cosmetic)

`CLAUDE.md:1`, `CONTEXT.md:1`, `CONTRIBUTING.md:16-17,97,100`,
`docs/COMMANDS.md`, `docs/DEPLOYMENT.md`,
`.github/agents/copilot-instructions.md`, and the npm workspace scope
`@antisocial/*` across every `package.json`.

> **Stale doc:** `docs/COMMANDS.md:110` claims the production worker is
> `journal-bot`; `wrangler.toml` says `antisocial-worker`. Fix while renaming
> (hazard §5.11).

---

## 14. What was actually built

Phases 1–4 are done. Four commits on `alexandria`, one repo extraction, one new
repo. `npm run lint`, `npx tsc -b` and `npm test` pass in all three.

| Repo | State |
| --- | --- |
| `syedi-code/alexandria` | Renamed from `antisocial-media`. PR #292 open against `main`. |
| `syedi-code/stylus` | Extracted with `git filter-repo`, 209 commits, builds and tests standalone. |
| `syedi-code/scribe` | New. Scaffolding that proves the auth chain end to end. |

### Where the plan was refined

- **A third module, `platform/`** (refines D4). `users`, `sessions`, `audit`,
  `limits`, `Env` and `AuthContext` are neither works nor writing, and filing
  them under `writing/` would have made `works/` import it transitively
  through the auth middleware. The rule is now three-way: writing may import
  works and platform; works may import platform only; platform imports
  neither. Strictly stronger than D4, same direction.
- **`/books/library` and `/books/:id/detail` live on the writing side.** The
  paths belong to works; the queries join quotes, notes and essays. Mounted
  ahead of the works router so the literal segment beats `/books/:id`.
- **`getLibraryBooks` splits into two queries, not a join.** `listCatalogue`
  reads works; `getWorkEnrichment` groups the writing tables in one pass and
  is merged in memory. Grouping over the whole table rather than binding a
  list of ids keeps it to one statement — D1 caps bound parameters well below
  a full catalogue page.
- **The migration renames rather than copies** (sharpens §10). `notes.book_id`
  and `quotes.book_id` carry `REFERENCES books(id)`; SQLite rewrites those
  clauses in place on rename, so both keep working. Copying into new tables
  would have left them pointing at a table that no longer exists, and every
  new note would have failed once foreign keys came back on. This was not in
  the plan and is the single most important thing the pre-flight caught.
- **The Pages project keeps its name; the hostname is added to it** (refines
  D22). A Pages project cannot be renamed, and recreating one means a new
  `*.pages.dev` plus re-adding every custom domain and Access policy. A
  project holds as many hostnames as you like, and the name is visible nowhere
  a reader looks. Same reasoning retires the worker rename.
- **`/works` routes were deliberately not added.** Nothing consumes them yet,
  and D27 makes API surface permanent once shipped. scribe's scaffolding
  proves its wiring against `/api/me`. Phase 5 adds them when there is a screen.

### A hazard the plan did not have

**`main` deploys the worker on push, and production has not been migrated.**
`.github/workflows/deploy-worker.yml` fires on push to `main`; the new worker
reads `works`, which does not exist in production yet. Merging before running
`0025_works.sql` takes the site down until it runs.

`cli/db/assert-migrated.ts` now runs in CI ahead of the deploy and refuses to
ship into that gap. It is a backstop, not a substitute for
`docs/WORKS-MIGRATION.md`.

### Left for a human

Everything below needs a Cloudflare token with `DNS:Edit`, `Access:Edit` and
`Pages:Edit` — the one in `.env` is read-only (§8).

1. Run the production migration. `docs/WORKS-MIGRATION.md`, in order.
2. Merge PR #292.
3. Add `stylus.` and `scribe.socialeating.studio` to the **existing** Access
   application. Do not create a new one (D10).
4. `wrangler pages domain add stylus.socialeating.studio --project-name antisocial-media`
5. `wrangler pages project create scribe`, add its domain, set `WORKER_URL`.
6. `npm run deploy` in alexandria — the `custom_domain` route provisions
   `alexandria.socialeating.studio` with no further steps.
7. Confirm `journal-bot` is dead, then delete it (§5.11).

---

## 15. The rollout — 2026-09-15

Both databases migrated, both workers deployed, both frontends on their own
Pages projects. What follows is what actually happened, including the parts
that went wrong.

### main had moved

Sixteen commits landed on `main` while the split was being built: the essay
writing room, the spine, the quote modal, a frontend test suite, a shuffle
index migration, and a rebuilt CI. Consequences:

- `0025_works.sql` became **`0026_works.sql`** — `main` took 0025 for
  `idx_notes_replaces_user`, already applied in both databases.
- `apps/web`'s sixteen commits were re-extracted with the same `filter-repo`
  options and **merged into stylus with real history**, not copied. The shared
  ancestor lines up because filter-repo is deterministic.
- `main`'s CI design was kept — Checks, Deploy → Staging, Deploy → Production,
  one composite action — cut down to the worker, plus the schema guard.
- The git rules from `main`'s CLAUDE.md now live in all three repos.

### The migration, on real data

| | Staging | Production |
| --- | --- | --- |
| works / creators | 7 / 20 | 124 / 83 |
| documents created | 5 | 105 |
| citations resolving, before → after | 25 → 25 | 1440 → 1440 |
| `PRAGMA foreign_key_check` | empty | empty |

Production was also missing `access_audit_log` — migration 0014 had never been
applied to it, so the audit endpoint would have 500'd. Applied alongside 0026.

### Two Cloudflare traps, both found the hard way

**Top-level `[[routes]]` are inherited by named environments.** Deploying
`--env staging` attached `api.ibrahimsyed.io` and
`alexandria.socialeating.studio` to the *staging* worker — pointing the
production API hostname at the staging database — and disabled the staging
worker's own `workers.dev` URL in the same deploy. Production served staging
data for about four minutes. No writes were possible: every write path needs a
session. `[env.staging]` now sets `routes = []` and `workers_dev = true`.

**`wrangler pages deploy` rewrites a project's variables from `wrangler.toml`**
and clears anything not declared there. `WORKER_URL` set through the API
vanished on the first deploy, and the Pages Function answered
`WORKER_URL not configured`. It now lives in each frontend's `wrangler.toml`
under `[vars]` and `[env.preview.vars]`, which is where a versioned,
non-secret hostname belongs anyway.

Both were caught by the deploy smoke tests rather than by a person noticing
later, which is the argument for having them.

### Deliberate choices made during the rollout

- **Frontends deploy from GitHub Actions, not Cloudflare's git integration.**
  The old `antisocial-media` Pages project was git-connected to this repo and
  built `apps/web/`, which this work deletes; a Pages project cannot be
  repointed at another repository. Its automatic deployments are disabled and
  its domains moved to the `stylus` project.
- **Every deploy ends in a smoke test that proves the chain**, not just the
  upload: the worker polls `/health`; each frontend POSTs `/api/session` and
  requires alexandria's own 401 back, which exercises the Pages Function,
  `WORKER_URL`, the Access bypass and the worker together.
- **alexandria's deploy workflows are disabled** until #293 and #294 merge,
  because `main` still holds code that reads `books`. Re-enable with
  `gh workflow enable deploy-production.yml` and the staging twin.
