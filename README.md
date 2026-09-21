# alexandria

The backend. One Cloudflare Worker, one D1, one R2, everything under `/api/`.

Two frontends read it and neither holds data of its own:

|                                                    |                                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| [**stylus**](https://github.com/syedi-code/stylus) | Notes, thoughts, quotes, essays. <https://stylus.socialeating.studio>        |
| [**scribe**](https://github.com/syedi-code/scribe) | Works, documents, and the reading half. <https://scribe.socialeating.studio> |

A third repository,
[**alexandria-mcp**](https://github.com/syedi-code/alexandria-mcp), is the MCP
server: the same library as five read-only tools a model can use. This worker
mounts it at `/api/mcp`.

alexandria itself answers at **<https://alexandria.socialeating.studio>**, and
serves a plain index of what the library holds at the root of it. It sits behind
Cloudflare Access, so an unauthenticated visit gets the login rather than the
library.

## The architecture, in one diagram

```text
packages/core/
├── works/     works, creators, documents, transcriptions, pages, media
├── writing/   thoughts, notes, quotes, essays, moods, sleep
└── platform/  identity, sessions, audit, the limits both use

     writing/   MAY import  works/  and  platform/
     works/     may NOT import writing/
     platform/  may import neither
```

Works is the record of what exists in the world — true regardless of who is
reading. Writing is one person's opinion about it. Writing points at Works;
Works never points back.

That direction is the whole architecture. Everything else is detail.

Nothing fails at runtime when it is violated, so it is held by a lint rule
(`eslint.config.mjs`) with a test that the rule still fires
(`packages/core/test/boundary.test.ts`). Both are production code.

## Running it

```bash
npm install
npm run dev:setup   # build a local SQLite database from sql/migrations/
npm run dev         # worker on :8787
npm test
```

`npm run dev` cannot reach production. It runs against a file.

## Reading further

|                           |                                                                     |
| ------------------------- | ------------------------------------------------------------------- |
| `CLAUDE.md`               | The working guide: layout, commands, and what will bite you         |
| `SECURITY.md`             | The three auth surfaces worth auditing, and the known limits        |
| `CONTEXT.md`              | The glossary. Authoritative on what words mean here                 |
| `CONTRIBUTING.md`         | Setup, workflow, and the rules for schema and API changes           |
| `docs/COMMANDS.md`        | Every npm script                                                    |
| `docs/DEPLOYMENT.md`      | Environments, secrets, auth, and why the names still say antisocial |
| `docs/WORKS-MIGRATION.md` | The runbook for `0026_works.sql`                                    |

## The catalogue page

`/` is a quiet index of what the library holds: titles and authors, and a search
field that filters as you type. One file, `apps/worker/public/index.html`,
served from the worker's `[assets]` binding. No build step, no framework, no
dependencies.

It reads `GET /api/catalogue`, the only route that answers without a session.
That route returns a bibliography and nothing else: no bucket keys, no page
text, nothing from `writing/`. Reading a document still takes a session and a
signed URL. It is off unless `PUBLIC_CATALOGUE` is `"true"` — see
`docs/DEPLOYMENT.md`.

## Two things to know before touching anything

**Never remap a UUID.** Work ids are embedded in essay prose as `[[book:UUID]]`
tokens, not only in foreign-key columns. Remapping one corrupts an essay written
years ago, silently, with nothing failing at write time.
`npm run verify:tokens:prod` is the check.

**The API is additive-only.** Two frontends read it on their own release
schedules. Never remove a field, never change a type, never narrow an enum.

## License

ISC.
