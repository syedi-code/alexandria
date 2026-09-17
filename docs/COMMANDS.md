# Commands reference

Every npm script in alexandria. The frontends live in their own repos (`stylus`,
`scribe`) and have their own.

---

## Root

### Development

| Command             | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| `npm run dev`       | Worker against the **local** D1 (SQLite in `.wrangler/state`). |
| `npm run dev:setup` | Build that local D1 by applying every migration. Run once.     |
| `npm test`          | vitest. No live D1 — see `packages/core/test/d1.ts`.           |
| `npm run lint`      | ESLint, including the works/writing boundary rule.             |
| `npm run format`    | Prettier.                                                      |

### Deployment

| Command                  | Description                      |
| ------------------------ | -------------------------------- |
| `npm run deploy:prod`    | Deploy the worker to production. |
| `npm run deploy:staging` | Deploy the worker to staging.    |

### Database

| Command                           | Description                                                     |
| --------------------------------- | --------------------------------------------------------------- |
| `npm run backup:prod`             | Dump production D1 to `sql/backups/`. Do this before migrating. |
| `npm run backup:staging`          | Same, for staging.                                              |
| `npm run sql:local -- <file>`     | Run a SQL file against the local D1.                            |
| `npm run sql:staging -- <f>`      | Against staging.                                                |
| `npm run sql:production -- <f>`   | Against production.                                             |
| `npm run db:status:prod`          | Row counts and table metadata.                                  |
| `npm run db:compare:staging-prod` | Diff two environments.                                          |

### Verification

| Command                         | Description                                                          |
| ------------------------------- | -------------------------------------------------------------------- |
| `npm run verify:tokens:prod`    | Every `[[book:UUID]]` in every essay resolves to a work. Exhaustive. |
| `npm run verify:tokens:staging` | Same, on staging.                                                    |
| `npm run debug:auth:prod`       | Live auth diagnostics against the deployed worker.                   |

Run the token check **before and after** anything that touches works. Work ids
are embedded in essay prose, so a remapped id corrupts an essay silently.

### Extraction

`npm run extract:notes`, `extract:thoughts`, `extract:books`, `extract:quotes`,
`extract:sleep`, `extract:threads`, `extract:essays`, or `extract:all`. Each
dumps a table to JSON.

### Pages and search

| Command                                     | Description                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `npm run pages:extract -- --env production` | Extract each PDF's text layer into `transcriptions` and `pages`.            |
| `npm run pages:index -- --env production`   | Build the FTS index in the SEARCH database from `pages`. Creates its schema. |

Both are resumable and stop before a document that would cross `--budget` rows
written (default 60,000 remote, unlimited local): D1 Free allows 100,000 a day
across everything, and hitting the cap breaks writes for stylus too. Add
`--dry-run` to see what would happen, `--document <id>` to limit the run,
`--force` to redo documents that are already done. Adding a new PDF:
`docs/INGESTING-PDFS.md`.

---

## Worker (`apps/worker`)

`npm run <script> -w @alexandria/worker`

| Command          | Description                                |
| ---------------- | ------------------------------------------ |
| `dev`            | Local D1 emulator. The safe default.       |
| `dev:staging`    | Remote staging D1.                         |
| `dev:remote`     | Remote **production** D1. Writes are real. |
| `deploy`         | Deploy production.                         |
| `deploy:staging` | Deploy staging.                            |

---

## CLI (`cli`)

`npm run <script> -w @alexandria/cli`

| Command         | Description                               |
| --------------- | ----------------------------------------- |
| `setup`         | Interactive wizard for a new environment. |
| `setup:env`     | Production environment.                   |
| `setup:staging` | Staging environment.                      |
| `setup:d1`      | Create the D1 database.                   |
| `setup:r2`      | Create the R2 bucket.                     |
| `setup:schema`  | Apply schema to a remote D1.              |
| `sync:secrets`  | Push secrets to the worker.               |
| `sync:dev-vars` | Generate `.dev.vars` from `.env`.         |

---

## Environments

| Environment    | Worker                      | D1                          |
| -------------- | --------------------------- | --------------------------- |
| **Local**      | `wrangler dev --local`      | SQLite in `.wrangler/state` |
| **Staging**    | `antisocial-worker-staging` | `antisocial-media-staging`  |
| **Production** | `antisocial-worker`         | `antisocial-media`          |

The production worker serves `alexandria.socialeating.studio` and
`api.ibrahimsyed.io`.

The worker, the database and the bucket keep their old names on purpose.
Cloudflare cannot rename a D1 database or an R2 bucket, and "renaming" one means
migrating live data to change a string no user ever sees. The worker could be
renamed, but only by deploying a second one and moving both custom domains
across. None of it is visible anywhere that matters.

---

## Quick start

```bash
npm install
npm run dev:setup   # build the local database
npm run dev         # worker on :8787, against local D1
npm test
```

## Notes

- **Local development cannot touch production.** `npm run dev` is a local SQLite
  file.
- **Migrations are idempotent.** `npm run dev:setup` is safe to re-run.
- **Tests build their schema from `sql/migrations/`**, replaying every file in
  order. A migration that drifts from the code fails in CI.
- **Run a migration on staging first**, all the way through the verification
  step. `docs/WORKS-MIGRATION.md` is the worked example.
