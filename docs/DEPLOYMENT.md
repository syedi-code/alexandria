# Deployment

alexandria is one Cloudflare Worker with one D1 and one R2 behind it. The two
frontends deploy from their own repos and reach it through a Pages Function
proxy, so nothing here has to know about them beyond a URL.

## The whole system

|                            | Production                                                                                                           | Staging                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **alexandria** (this repo) | Worker `antisocial-worker` at `alexandria.socialeating.studio` and `api.ibrahimsyed.io`                              | Worker `antisocial-worker-staging` at `antisocial-worker-staging.iysyed01.workers.dev` |
| **stylus**                 | Pages `stylus`, branch `main`, at `stylus.socialeating.studio`, `anti.socialeating.studio`, `journal.ibrahimsyed.io` | Pages `stylus`, branch `staging`, at `staging.stylus-64v.pages.dev`                    |
| **scribe**                 | Pages `scribe`, branch `main`, at `scribe.socialeating.studio`                                                       | none — production only until it needs one                                              |
| D1                         | `antisocial-media` (`069d3dc5-2f80-4333-be34-d3b1cf455af7`)                                                          | `antisocial-media-staging` (`ba85f6dc-715a-48de-bb9f-49d3907fbf79`)                    |
| R2                         | `antisocial-media-files`                                                                                             | `antisocial-media-files-staging`                                                       |

The production bucket holds one thing that is not alexandria's: scribe's
typeface, under `scribe-fonts/`. GT Alpina is licensed to serve and not to
redistribute, so it cannot live in scribe's repository; scribe's deploy copies
it out of this prefix before building (scribe's `FONTS.md`). Nothing in
alexandria reads, lists or signs these keys. Do not clear the prefix: the next
scribe deploy fails without it.

The worker also runs one cron (`[triggers]` in `wrangler.toml`, inherited by
staging): daily at 04:17 UTC it deletes sessions that expired more than 30 days
ago. D1 has no TTL of its own.

Each frontend's Pages project has a `WORKER_URL` variable per environment:
production points at `https://alexandria.socialeating.studio`, preview at the
staging worker.

## CI/CD

Three workflows, each doing one obvious thing:

| Workflow                | Runs on                                            | What it does                                                         |
| ----------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| **Checks**              | every PR into `main`/`staging`, and pushes to them | lint (including the boundary rule), `tsc -b`, vitest. Never deploys. |
| **Deploy → Staging**    | push to `staging`, or by hand                      | worker → staging                                                     |
| **Deploy → Production** | push to `main`, or by hand                         | worker → production                                                  |

Both deploy workflows call `.github/actions/deploy-cloudflare`, so staging and
production cannot drift apart in how they deploy. That action:

1. **Refuses to deploy code that is ahead of the schema.**
   `cli/db/assert-migrated.ts` checks the target database has every table the
   code reads. A worker that lands before its migration takes the environment
   down until the migration runs.
2. Deploys the worker.
3. Polls `/health` until it answers.

Migrations are **not** applied by CI. They are run by hand, deliberately, in the
order `docs/WORKS-MIGRATION.md` lays out.

### Deploying by hand

```bash
npm run deploy:staging   # worker → staging
npm run deploy:prod      # worker → production
```

There is deliberately no bare `npm run deploy`; every script names its
environment. Local deploys read `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` from `.env`. CI uses repository secrets of the same
names.

### What the token needs

| Scope   | Permission                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------- |
| Account | Workers Scripts: Edit · D1: Edit · Workers R2 Storage: Edit · Cloudflare Pages: Edit · Account Settings: Read |
| Zone    | Zone: Read · DNS: Edit · Workers Routes: Edit                                                                 |
| User    | User Details: Read · Memberships: Read                                                                        |

`Access: Apps and Policies: Edit` is only needed to change which hostnames sit
behind Cloudflare Access — never by CI.

## Custom domains

`alexandria.socialeating.studio` and `api.ibrahimsyed.io` are `custom_domain`
routes in `apps/worker/wrangler.toml`. wrangler provisions their DNS records on
deploy; there is nothing to click.

Pages custom domains are attached to the Pages project, with a proxied CNAME to
`<project>.pages.dev` on the zone.

> **Top-level `[[routes]]` are inherited by named environments.** Deploying
> `--env staging` without clearing them attaches production's custom domains to
> the staging worker — which reads the staging database — and disables that
> worker's `workers.dev` URL at the same time. `[env.staging]` sets
> `routes = []` and `workers_dev = true` to prevent it. Learned the hard way:
> `api.ibrahimsyed.io` served staging data for four minutes on 2026-09-15.

## Auth

Three Cloudflare Access applications:

| Application                         | Hostnames                          | What it is for                                                                                           |
| ----------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `antisocial-media`                  | every production frontend hostname | Login. Its `aud` is the production worker's `POLICY_AUD`.                                                |
| `antisocial-staging`                | `staging.stylus-64v.pages.dev`     | Login for staging. Its `aud` is the staging worker's `POLICY_AUD`.                                       |
| `antisocial-media-api-route-bypass` | `<each frontend hostname>/api/`    | Bypass, so API calls are never redirected to a login page mid-session. The worker checks the JWT itself. |

When a frontend gains a hostname, add it to the login application **and** its
`/api/` path to the bypass application. Do not create a new login application:
that mints a new `aud` and forces rotating `POLICY_AUD` on the worker.

The worker is **not** behind Access. It validates the Access JWT itself, against
`TEAM_DOMAIN` and `POLICY_AUD` (`apps/worker/api/auth.ts`). `GET /api/me` on a
bare request returns `401` from application code rather than a `302` to a login
page — that is correct, and it keeps a bearer-token path open for non-browser
clients.

## Secrets

Set with `npx wrangler secret put <KEY>` from `apps/worker` (add `--env staging`
for staging), or all at once with `npm run sync:secrets`.

| Secret                   | What it is                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `TEAM_DOMAIN`            | Access team domain, e.g. `socialeating.cloudflareaccess.com`                       |
| `POLICY_AUD`             | The login Access application's `aud` for that environment                          |
| `ADMIN_EMAIL`            | The one address that gets the `admin` role                                         |
| `FILE_SIGNING_SECRET`    | HMAC key for signed R2 URLs. The only thing guarding the bucket — see SECURITY.md  |
| `MCP_POLICY_AUD`         | `aud` of the Access application covering `/api/mcp`                                |
| `MCP_SERVICE_TOKEN_ID`   | Client id of the one service token allowed to call it                              |
| `PUBLIC_CATALOGUE`       | `"true"` serves `GET /api/catalogue` without a session. Anything else, and it 404s |
| `ANTHROPIC_API_KEY` &co. | Scribe's model roster. A provider without a key is left off it                     |

`FILE_SIGNING_SECRET` must be set, or no file can be fetched by any route: a
signature that cannot be checked is not trusted.

### The catalogue page

`/` serves `apps/worker/public/index.html`, a static index of the documents the
library holds, from the `[assets]` binding in `wrangler.toml`.
`not_found_handling = "none"` is load-bearing: only an exact file match is
served from `public/`, so every `/api/` path still reaches the worker.

The page reads `GET /api/catalogue`, the one route that answers without a
session. It returns titles, creators, years and page counts — never a bucket
key, page text, or anything from `writing/`. Opening a document still needs a
session and a signed URL, so publishing the catalogue cannot expose one.

It is off unless `PUBLIC_CATALOGUE` is `"true"`, because a reading list is a
personal thing to publish. To take it down:

```bash
cd apps/worker
npx wrangler secret delete PUBLIC_CATALOGUE
```

The page then explains that the catalogue is not published, and every other
route is unaffected.

## Why the names still say antisocial

Cloudflare cannot rename a D1 database or an R2 bucket. "Renaming" means
creating a new one, copying every row or object across, and repointing the
binding — risking the only irreplaceable thing in the system to change a string
no user ever sees.

A worker cannot be renamed either; deploying under a new name creates a second
worker. That is possible — deploy new, move both custom domains, delete old —
but it buys nothing, because the name appears only in the dashboard and on
`*.workers.dev`. The hostname is what people see.

## Initial setup for a new environment

```bash
npm run setup:staging -w @alexandria/cli
```

`cli/setup/create-d1-resources.ts` and `create-r2-resources.ts` create the
resources and write their ids back into `wrangler.toml`.
