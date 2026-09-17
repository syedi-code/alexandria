# Ingesting a PDF

How a new PDF becomes text that Scribe can search, read and cite. For people and
for agents; follow it in order.

A PDF is not readable by Scribe just because it is uploaded. Its text has to be
**extracted** into `pages` and then **indexed** into the SEARCH database. Both
are CLI commands, run from the repo root, and both only ever do work that is
still outstanding — so the normal case is two commands with no arguments.

## The short version

```bash
npm run pages:extract -- --env production
npm run pages:index -- --env production
```

Each skips everything already done. Read the output: every document gets a line,
and a failure is reported without stopping the run.

## 1. The PDF has to be a Document

Uploading a PDF against a book (stylus's library, `POST /api/upload/pdf`, then
the book's `pdf_url`) creates or updates that work's primary row in `documents`.
That row is what the commands pick up. Check it exists:

```bash
cd apps/worker
npx wrangler d1 execute antisocial-media --remote --command \
  "SELECT d.id, d.r2_key, d.current_transcription_id, w.title
     FROM documents d JOIN works w ON w.id = d.work_id
    WHERE w.title LIKE '%Republic%'"
```

`r2_key` may read `/files/books/...` rather than a bare bucket key. That is
expected — stylus receives it as `pdf_url` — and everything in core goes through
`documentObjectKey()`. Never rewrite the column.

Set the page offset while you're there, so citations show the number printed on
the paper: if printed page 1 is PDF page 15, the offset is 14 (the book's
`pdf_page_offset` in stylus, `documents.page_offset` here).

## 2. Extract the text layer

```bash
npm run pages:extract -- --env production --document <document id>
```

Drop `--document` to extract every document that has no text yet. This downloads
the PDF from R2, reads each page's embedded text with `unpdf`, and writes one
`transcriptions` row (`model = 'pdf-text-layer'`) and one `pages` row per PDF
page. The new transcription becomes the document's current one unless the
document already points at a different transcription, such as a future
model-made one; a re-extraction never demotes that.

What the output means:

| Line                               | Meaning                                                   |
| ---------------------------------- | --------------------------------------------------------- |
| `412 pages`                        | extracted                                                 |
| `412 pages, 6 blank`               | fine: blank pages are usually plates, dividers, endpapers |
| `51 pages, no text layer (a scan)` | stored, but nothing to search. See _Scans_                |
| `✗ … Unexpected wrangler output`   | usually auth: `npx wrangler login`, then run again        |

**Replacing a PDF** with a better file: upload it, then re-extract with
`--force --document <id>`. The old text-layer transcription and its pages are
replaced in the same write.

## 3. Index it for search

```bash
npm run pages:index -- --env production --document <document id>
```

Drop `--document` to index everything whose index is missing or stale. A
document is stale when its current transcription is not the one its index rows
were built from, so re-extracting a document is enough to get it re-indexed on
the next run. The search database is derived data; losing it costs a rebuild.

## 4. Check it

The fastest check is through MCP (`list_works` shows each document's `text` as
`searchable`, `scan` or `not_extracted`; `search_pages` should find a phrase you
can see on a page). Or directly:

```bash
npx wrangler d1 execute antisocial-media --remote --command \
  "SELECT COUNT(*) AS pages, SUM(text IS NOT NULL) AS with_text
     FROM pages p JOIN documents d ON p.transcription_id = d.current_transcription_id
    WHERE d.id = '<document id>'"
```

`pages` should equal the PDF's page count.

## Budget: the part that can hurt

D1's free plan allows **100,000 rows written per day across the whole account**,
stylus included, resetting at 00:00 UTC. Hitting it makes D1 refuse writes for
the rest of the day — stylus stops saving too.

Measured in production:

| Command         | Rows written                                |
| --------------- | ------------------------------------------- |
| `pages:extract` | 4 per page + 8 per document                 |
| `pages:index`   | about 2 per page (confirm on the first run) |

A 400-page book costs ~1,600 rows to extract and ~800 to index — nothing. A
whole library is where it matters. Both commands stop _before_ a document that
would cross `--budget` (default 60,000; unlimited with `--env local`) and count
the rows D1 actually reports, so a stopped run is safe to repeat the next day.
Raise `--budget` only when you know nothing else will write much that day.

## Scans

A PDF without a text layer is extracted as pages with no text. It is listed as
`scan`, it cannot be searched, and citations to it are `unverifiable`. A model
can still look at a page through `view_page`, for PDFs up to 24 MB. Making a
scan searchable needs a model-made transcription, which does not exist yet; the
tables are ready for one (a second `transcriptions` row, made current).

## Don'ts

- **Don't write `pages` by hand or through the worker.** A free-plan worker
  request has 10 ms of CPU; a book's text doesn't fit. The CLI writes through
  wrangler.
- **Don't delete a document's transcriptions to force a redo.** Use `--force`;
  it replaces in one write and keeps the current-transcription pointer correct.
- **Don't back up or migrate the SEARCH database.** Rebuild it.
- **Don't run against production to test.** `--dry-run` downloads and extracts
  without writing, and reports the rows it would use.
