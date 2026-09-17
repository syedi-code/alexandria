# Contributing to alexandria

## Prerequisites

- Node.js 24+ and npm
- A Cloudflare account (the free tier is enough)

## Getting started

```bash
git clone https://github.com/syedi-code/alexandria.git
cd alexandria
npm install
npm run setup       # wrangler login, create D1, apply schema, write .env
npm run dev:setup   # build the local database from sql/migrations/
npm run dev         # worker on :8787, against local SQLite
npm test
```

Local development cannot reach production. `npm run dev` runs against a SQLite
file under `.wrangler/state/`.

## The shape of the thing

```text
       stylus                      scribe
   (writing, Vue 3)            (works, greenfield)
         │                            │
         └────────── /api/* ──────────┘
                       │
                  alexandria
              Hono on Workers
                  │       │
                 D1      R2
```

Each frontend is a separate repo and reaches alexandria through its own Pages
Function proxy, so the browser only ever talks to its own origin.

Inside alexandria:

| Directory                 | What lives there                                         |
| ------------------------- | -------------------------------------------------------- |
| `packages/core/works/`    | Works, creators, documents, transcriptions, pages, media |
| `packages/core/writing/`  | Thoughts, notes, quotes, essays, moods, sleep            |
| `packages/core/platform/` | Identity, sessions, audit, the limits both use           |
| `apps/worker/api/`        | Routes, split the same three ways                        |
| `cli/`                    | Setup, migration, backup, extraction                     |
| `sql/migrations/`         | Applied in order; the tests replay them                  |

## The rule that matters

`writing/` may import `works/`. `works/` may **not** import `writing/`, and
`platform/` may import neither.

Nothing fails at runtime when you cross that line, which is exactly why it is
enforced by `no-restricted-imports` in `eslint.config.mjs`, and why
`packages/core/test/boundary.test.ts` checks that the rule still fires on a
deliberate violation. Run `npm run lint` before you push. Do not disable the
rule, not even temporarily.

`@alexandria/core` exposes `/works`, `/writing` and `/platform` as subpaths so
the direction of each import is visible in the import line.

## Workflow

```bash
git checkout -b feature/my-change
# ...
npm run lint
npm run format
npm test
```

Then push and open a pull request.

## Database changes

Add a numbered file to `sql/migrations/`. The tests build their schema by
replaying every migration in order, so a migration that does not match the code
fails in CI rather than in production.

```bash
npm run sql:local -- 0026_my_change.sql
npm run sql:staging -- 0026_my_change.sql
npm run sql:production -- 0026_my_change.sql
```

Two rules with no exceptions:

**Never remap a UUID.** Work ids live inside essay prose as `[[book:UUID]]`
tokens, not only in foreign-key columns, so a remapped id corrupts an essay
written years ago with nothing failing at write time. Run
`npm run verify:tokens:prod` before and after.

**Back up before anything irreversible.** `npm run backup:prod`. D1 Time Travel
gives 30-day point-in-time restore on top of that, but it is not a reason to
skip the dump.

`docs/WORKS-MIGRATION.md` is the worked example.

## API changes

Additive only. Two frontends read this API and they deploy on their own
schedules, so never remove a field, never change a field's type, and never
narrow an enum. Add the new thing and let the old consumer lag.

A breaking change is not forbidden — it becomes a deliberate, planned change
across three repos rather than something stumbled into.

## Style

ESLint and Prettier, enforced. Be extremely light on comments: add one only
where the intent is not obvious from reading the code.

## License

ISC.
