# Scribe's backend

Scribe answers philosophy questions from the PDFs in Works, and every claim it
makes about a text links to the page it came from. This is everything alexandria
does for it, and the order to switch it on in.

Design decisions and their reasoning live in `open_src/plans/`. Adding a PDF
after all this is running: `docs/INGESTING-PDFS.md`.

## What exists

| Piece                                                            | Where                                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Page text: text layers extracted into `transcriptions` / `pages` | `packages/core/works/transcriptions.ts`, `cli/ingest/extract-pages.ts`      |
| Page search: FTS5 in the SEARCH database                         | `packages/core/works/search.ts`, `sql/search/`, `cli/ingest/index-pages.ts` |
| Citation checks                                                  | `packages/core/works/citations.ts`                                          |
| The tools models read with                                       | `packages/core/works/tools.ts`                                              |
| Conversations, messages, page handles                            | `packages/core/conversations/`, `sql/migrations/0027_conversations.sql`     |
| The chat agent and its routes                                    | `apps/worker/api/conversations/`                                            |
| The MCP server                                                   | `apps/worker/api/mcp/`                                                      |
| Document routes for citation links                               | `apps/worker/api/works/documents.ts`                                        |

## Switching it on

Each step is safe on its own, and nothing below changes what stylus sees.

### 1. Migrate

`0027` only adds tables, so it can run before or after a deploy.

```bash
npm run backup:prod
npm run sql:production -- 0027_conversations.sql
```

### 2. Create the search databases

```bash
cd apps/worker
npx wrangler d1 create alexandria-search
npx wrangler d1 create alexandria-search-staging
```

Done for this account: both are bound as `SEARCH` in
`apps/worker/wrangler.toml`. A new environment needs its own, with the id pasted
into a `SEARCH` block.

### 3. Extract page text — night one

```bash
npm run pages:extract -- --env production --document <one document id>
```

Read the rows it reports for that one document against the estimate, then run
the rest:

```bash
npm run pages:extract -- --env production
```

Production bills **4 rows per page plus 8 per document** — about 129,000 rows
for this library, so extraction takes two days. Anything that fails is reported
and retried next run.

### 4. Build the index — night two

```bash
npm run pages:index -- --env production
```

Creates the schema on first run. Probably ~2 rows per page (~64,000 for this
library) — production billed extraction at double its local count, so the same
is assumed here. The first documents' reported rows will say.

Free-tier limits reset at 00:00 UTC. Hitting the limit makes D1 refuse writes
for the rest of the day **for stylus too**, which is why both commands are
budgeted.

### 5. Provider keys

A provider without a key is left off the model roster; set any subset.

```bash
cd apps/worker
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GOOGLE_GENERATIVE_AI_API_KEY
```

### 6. Deploy, then measure CPU

```bash
npm run deploy:prod
cd apps/worker && npx wrangler tail --format pretty
```

Send one real question through Scribe while tailing. Free workers get **10 ms of
CPU per request**; network waits don't count, but streaming and verification do.
If requests end with _exceeded resource limits_, the chat endpoint needs Workers
Paid ($5/month). Nothing else here does.

Measured on production, `wrangler tail --format json` reporting `cpuTime`:

| Request                          | CPU   |
| -------------------------------- | ----- |
| `GET /api/catalogue`             | 12 ms |
| `search_pages` over 21,656 pages | 63 ms |
| `read_pages`, five pages         | 11 ms |

All three are over the free allowance and all three returned `ok`, so the limit
is evidently not enforced per request at this volume. Do not read that as
headroom: one chat turn is a dozen such requests inside one invocation, and
nothing in the free plan promises to keep tolerating it. The chat endpoint is
the first thing that will need Workers Paid.

A turn has not been measured end to end, because driving the deployed chat route
needs a browser session and Scribe's frontend does not exist yet.

### 7. MCP, for you alone

MCP clients authenticate with a Cloudflare Access **service token**. No OAuth.

1. **Zero Trust → Access → Service Auth → Service Tokens**: create
   `alexandria-mcp`. Keep the client ID and secret.
2. **Zero Trust → Access → Applications**: add a self-hosted application for
   `alexandria.socialeating.studio/api/mcp`, with one policy: action **Service
   Auth**, include **Service Token → alexandria-mcp**. Copy its AUD tag.
3. Tell the worker which application and token to trust:

    ```bash
    npx wrangler secret put MCP_POLICY_AUD         # the application's AUD tag
    npx wrangler secret put MCP_SERVICE_TOKEN_ID   # the token's client ID
    ```

4. Connect a client:

    ```bash
    claude mcp add --transport http alexandria https://alexandria.socialeating.studio/api/mcp \
      --header "CF-Access-Client-Id: <client id>" \
      --header "CF-Access-Client-Secret: <client secret>"
    ```

    Claude Desktop's connector screen can't send headers; use its config file
    with the `mcp-remote` bridge and the same two headers.

Access rejects anything without the token before the worker sees it; the worker
then checks the signed assertion names that token. Revoke by deleting the token.

## The API

All routes are under `/api` and need a session, except `/api/mcp`.

| Method | Path                             |                                                                             |
| ------ | -------------------------------- | --------------------------------------------------------------------------- |
| GET    | `/models`                        | the models with keys set, and the default                                   |
| GET    | `/conversations?before=&limit=`  | the caller's conversations, most recent first                               |
| POST   | `/conversations`                 | `{ title?, model_id? }`                                                     |
| GET    | `/conversations/:id`             | `{ conversation, messages }` — messages are AI SDK UI messages              |
| PATCH  | `/conversations/:id`             | `{ title?, model_id? }`                                                     |
| DELETE | `/conversations/:id`             | soft delete                                                                 |
| POST   | `/conversations/:id/chat`        | `{ message: { role: 'user', parts: [{ type: 'text', text }] }, model_id? }` |
| GET    | `/documents/:id`                 | a citation's target: work, pagination, `file_key` for `/files/sign`         |
| GET    | `/documents/:id/pages?from=&to=` | extracted text, at most five pages                                          |
| ALL    | `/mcp`                           | MCP over Streamable HTTP, stateless                                         |

**What a reader should be shown.** An answer message holds the text of every
step, not only the last one, and models narrate their searching between tool
calls ("Let me read the fuller context…") however firmly the instructions ask
them not to. The answer is the text after the final `step-start`; the earlier
text belongs with the tool activity, collapsed or beside it. A frontend that
renders every text part in sequence shows the reader the model thinking out loud
and calls it the answer.

`POST /conversations/:id/chat` streams an AI SDK UI message stream, so scribe's
`useChat` reads it directly. Send only the new message; history is loaded on the
server. The stream ends with a `data-citations` part: every citation in the
answer, its page, and whether its quote was found there.

## How an answer is kept honest

1. Every page a tool shows the model is labelled with a handle — `[P7]`.
2. The model cites as `[P7 "verbatim words"]`, or as `"verbatim words" [P7]`,
   which is what smaller models tend to write. A handle exists only for a page
   it was shown, so it can't cite a page it never read.
3. After the answer, each quote is normalised (case, diacritics, ligatures,
   punctuation, line-break hyphens) and looked for on its page, or across the
   break onto the next.
4. Both readings of a hyphen are tried, since extraction turns a dash into one
   (`rationalism-their`) as readily as it breaks a word across a line
   (`self- deception`); a quote may elide words with `...`, provided every part
   of it is on the page in order.
5. The result — `verified`, `unverified`, or `unverifiable` for a page without
   text — is streamed to the reader, saved with the message, and written to
   `citations`.

An unverified citation carries a reason. `partial_match` means the quote begins
on the page and then diverges: either the scan is damaged mid-quote, or the
model misquoted. It says where to look, not who is at fault. It is common on
long quotes, which is why the instructions ask for five to twenty words.

"Verified" means the words are on the page. It does not mean they support the
claim. The verification rate per model, and per document, is in `citations`:

```sql
SELECT m.model_id, c.status, COUNT(*)
  FROM citations c JOIN messages m ON m.id = c.message_id
 GROUP BY m.model_id, c.status;
```

Documents whose citations rarely verify are the ones whose text layer needs a
real transcription.
