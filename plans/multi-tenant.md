# Multi-Tenant Support Plan

**Date:** 2026-03-04 (updated 2026-03-04)  
**Branch:** `users` (building on 0012-users migration)  
**Status:** Planning

---

## Current State

The `users` branch has laid the groundwork:

| Layer | What exists | What's missing for multi-tenancy |
|-------|-------------|----------------------------------|
| **Schema** | `users` table + `user_id` FK on all 10 entity tables (0012-users.sql) | No composite indexes for `(user_id, ...)` queries |
| **Auth middleware** | CF Access JWT → `authContext { user, role }` on every request | Role model is binary (`admin`/`viewer`); no per-user ownership enforcement |
| **DB writes** | All `create*` functions accept optional `userId` and store it | `createConnection` does **not** accept/store `userId` |
| **DB reads** | None filter by `user_id` | All `get*` functions return all rows regardless of user |
| **DB updates/deletes** | None verify ownership | Any admin can modify/delete any record |
| **Frontend** | Auth state via `useAuth()`, admin-gated UI controls | No concept of "my data" vs "other users' data" |

---

## Design Decisions

### Tenant isolation model

**Row-level isolation in a shared D1 database.** Every entity row's `user_id` column determines ownership. This is the right model for a private-by-default personal tool sharing a single Cloudflare D1 instance — no need for separate databases per user.

### Visibility model

**All user entities are private.** No sociality, no cross-user feeds. Each user sees only their own data.

| Entity type | Reads | Writes |
|-------------|-------|--------|
| **Notes, quotes, thoughts, media, links, sleep, threads, connections** | **Private** — owner only (+ admin) | Owner creates/edits/deletes own |
| **Books, authors** (library) | **Public** — all authenticated users can browse | **Admin only** can create/edit/delete |
| **Book requests** | Requester + admin can see | Any authenticated user can request |

> **Rationale:** This is a personal knowledge tool — each user's content is their own private workspace. The library (books & authors) is a shared, curated reference layer managed by the admin. Users who want a book added can submit a request rather than adding it directly.

### Role model

Current: `email === ADMIN_EMAIL → admin, else viewer`  
Target: Keep this, but "viewer" becomes a full user with private read/write access to their own content.

| Role | Own entities | Library (books/authors) | Book requests | Admin actions |
|------|-------------|------------------------|---------------|---------------|
| `user` | Full CRUD | Read-only | Can submit | No |
| `admin` | Full CRUD (own) + read/write all | Full CRUD | Can view & fulfill | Yes |

---

## Implementation Plan

### Phase 1 — Schema & DB layer: tenant-scoped queries

**Goal:** Every DB function enforces user isolation. Private entities are always scoped. Library is unscoped for reads.

#### 1.1 Book requests table + composite indexes (new migration `0013-book-requests-and-indexes.sql`)

```sql
-- =============================================================================
-- Book Requests — users can request books to be added to the shared library
-- =============================================================================
CREATE TABLE IF NOT EXISTS book_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    author_name TEXT,             -- Free-text; may not match an existing author
    isbn TEXT,
    notes TEXT,                   -- Why they want the book, edition preference, etc.
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
    admin_notes TEXT,             -- Admin response / reason
    fulfilled_book_id TEXT REFERENCES books(id),  -- Set when admin creates the book
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_book_requests_user   ON book_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_book_requests_status ON book_requests(status);

-- =============================================================================
-- Composite indexes for user-scoped queries on private entities
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_notes_user_created      ON notes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_user_created      ON quotes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thoughts_user_created    ON thoughts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_user_created       ON media(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_links_user_created       ON links(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sleep_user_created       ON sleep(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_threads_user_created     ON threads(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_connections_user          ON connections(user_id);
```

> Books and authors do NOT get user-scoped composite indexes — they are a public shared library. The existing `idx_books_user` / `idx_authors_user` from 0012 stay for admin provenance queries only.

#### 1.2 Update `packages/core/database/db-d1.ts` — private entities

For the 8 private entity types (notes, quotes, thoughts, media, links, sleep, threads, connections), the `userId` parameter becomes **mandatory** for reads and enforced for writes:

**Read functions** — `userId` is required (admin passes their own ID too, or a special bypass):

```typescript
// Before:
export async function getNotes(db, opts: { limit; offset; search; posted; book_id })

// After:
export async function getNotes(db, opts: { limit; offset; search; posted; book_id; userId: string })
// Always applies: WHERE user_id = ?
// Admin bypass: pass a special `userId: '*'` sentinel to get all rows (for admin diagnostics only)
```

**Update/Delete functions** — `userId` is required, enforced in WHERE clause:

```typescript
// Before:
export async function deleteNote(db, id: string): Promise<void>

// After:
export async function deleteNote(db, id: string, userId: string): Promise<void>
// Always applies: WHERE id = ? AND user_id = ?
// Admin bypass: userId = '*' skips the user_id check
// Throws OwnershipError if 0 rows affected
```

**Pattern:** Admin callers pass `userId: '*'`, regular users pass their actual ID. The DB layer handles the conditional:

```typescript
if (userId !== '*') {
  conditions.push('user_id = ?');
  params.push(userId);
}
```

Apply to: `getNotes`/`getNoteById`, `getQuotes`/`getQuoteById`, `getMediaList`/`getMediaById`, `getLinks`/`getLinkById`, `getSleepEntries`/`getSleepById`, `getThreads`/`getThreadById`/`getThreadItems`, `getConnections`/`getConnectionsOfType`, and all `update*`/`delete*` counterparts.

#### 1.3 Library functions (books/authors) — no user scoping

`getBooks`, `getBookById`, `getAuthors`, `getAuthorById`, `getBooksByAuthorId` remain unchanged — no `userId` filter. These are public reads.

`createBook`, `createAuthor` — keep the optional `userId` param for provenance tracking (who added the book). Only admin can call these via middleware, not DB-level enforcement.

`updateBook`, `deleteBook`, `updateAuthor`, `deleteAuthor` — no `userId` param needed. Admin-only is enforced at the API middleware layer.

#### 1.4 Book requests — new DB functions

```typescript
export async function createBookRequest(db, input: BookRequestInput, userId: string): Promise<BookRequest>
export async function getBookRequests(db, opts: { userId?: string; status?: string; limit; offset }): Promise<BookRequest[]>
export async function getBookRequestById(db, id: string): Promise<BookRequest | null>
export async function updateBookRequest(db, id: string, updates: Partial<BookRequest>): Promise<void>  // admin only
```

#### 1.5 Fix `createConnection` to accept and store `userId`

```typescript
// Currently: createConnection(db, input)
// Change to: createConnection(db, input, userId: string)
// INSERT should include user_id column
```

#### 1.6 Move inline thought DB functions to `db-d1.ts`

Move `getThoughts`, `getAllThoughts`, `getThought`, `createThought`, `updateThought`, `deleteThought`, `getAllMoodTags` from `apps/worker/api/thoughts.ts` to the shared `db-d1.ts` module. Apply the mandatory `userId` pattern.

#### 1.7 Add types

- Add `BookRequest` type and `BookRequestInput` Zod schema to `packages/core/types.ts`
- Add `user_id` to Zod Row schemas in `packages/core/database/schema.ts` (for API responses)
- Add `user_id` to `Thought` type in `packages/core/types.ts`
- Export `OwnershipError` class from `@antisocial/core`

---

### Phase 2 — API layer: enforce isolation

**Goal:** Every route handler enforces the correct access pattern — private entities scoped to user, library publicly readable.

#### 2.1 Create a helper to extract userId from context

```typescript
// apps/worker/api/helpers.ts
import type { Context } from 'hono';
import type { Env, AuthContext } from '@antisocial/core';

type AppContext = Context<{ Bindings: Env; Variables: { authContext: AuthContext } }>;

/** Get authenticated user's ID. Always returns a string (auth middleware guarantees it). */
export function getUserId(c: AppContext): string {
  return c.get('authContext')!.user.id;
}

/**
 * Get the userId to pass to DB functions for ownership scoping.
 * - Admin: returns '*' (bypass — can see/modify all)
 * - Regular user: returns their actual ID
 */
export function getScopedUserId(c: AppContext): string {
  const auth = c.get('authContext')!;
  return auth.role === 'admin' ? '*' : auth.user.id;
}
```

#### 2.2 Add `authenticatedMiddleware` to auth.ts

```typescript
/**
 * Middleware that requires any authenticated user (admin or regular).
 * Use for routes where ownership is enforced at the DB layer.
 */
export function authenticatedMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authContext = c.get('authContext');
    if (!authContext) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    return next();
  };
}
```

#### 2.3 Route migration — private entities

For notes, quotes, thoughts, media, links, sleep, threads, connections:

| Verb | Current middleware | New middleware | userId passed to DB |
|------|-------------------|---------------|---------------------|
| GET (list) | *(none beyond auth)* | *(same)* | `getScopedUserId(c)` — user sees own, admin sees all |
| GET (by id) | *(none)* | *(same)* | `getScopedUserId(c)` — user can only fetch own |
| POST | `adminOnlyMiddleware()` | `authenticatedMiddleware()` | `getUserId(c)` — stamps ownership |
| PATCH | `adminOnlyMiddleware()` | `authenticatedMiddleware()` | `getScopedUserId(c)` — DB enforces ownership |
| DELETE | `adminOnlyMiddleware()` | `authenticatedMiddleware()` | `getScopedUserId(c)` — DB enforces ownership |

**On `OwnershipError` from DB:** return `403 Forbidden` with `{ error: 'You do not own this resource' }`.

#### 2.4 Route migration — library (books/authors)

| Verb | Current middleware | New middleware | userId passed to DB |
|------|-------------------|---------------|---------------------|
| GET (list/by-id) | *(none beyond auth)* | *(same — any authenticated)* | None (public library) |
| POST | `adminOnlyMiddleware()` | `adminOnlyMiddleware()` | `getUserId(c)` (provenance only) |
| PATCH | `adminOnlyMiddleware()` | `adminOnlyMiddleware()` | None |
| DELETE | `adminOnlyMiddleware()` | `adminOnlyMiddleware()` | None |

Books and authors stay admin-only for writes. No ownership scoping needed.

#### 2.5 New routes — book requests

```
POST   /book-requests          authenticatedMiddleware()  → createBookRequest(db, body, getUserId(c))
GET    /book-requests           authenticatedMiddleware()  → user sees own; admin sees all (via getScopedUserId)
GET    /book-requests/:id       authenticatedMiddleware()  → scoped by userId
PATCH  /book-requests/:id       adminOnlyMiddleware()      → updateBookRequest (approve/reject/fulfill)
```

---

### Phase 3 — Frontend: private-first UI

**Goal:** Each user sees only their own content. Non-admin users get full CRUD on their own data. Library tab is shared/public with a "Request a book" action.

#### 3.1 Update auth state

```typescript
// lib/auth.ts — add:
const isAuthenticated = computed(() => !!user.value);
const userId = computed(() => user.value?.id ?? null);
```

#### 3.2 All users get write controls

Since all entity content is private (user can only see their own), every item shown is owned by the current user. Therefore:

```vue
<!-- Before: only admin sees edit/delete -->
<button v-if="isAdmin" @click="editNote(note)">Edit</button>

<!-- After: any authenticated user sees edit/delete (they can only see their own items) -->
<button v-if="isAuthenticated" @click="editNote(note)">Edit</button>
```

No need to compare `note.user_id === userId` — the API already only returns the user's own items.

#### 3.3 Allow non-admin users to access capture forms

Currently `CaptureForm`, `QuoteCaptureForm`, `ThoughtCapture`, etc. are gated on `isAdmin`. Change to `isAuthenticated`.

#### 3.4 Library tab — "Request a Book" button

For the library tab (books/authors):

- All users can browse books and authors (public reads)
- Admin users see "Add Book" / "Edit" / "Delete" buttons (same as today)
- Non-admin users see a "Request a Book" button → opens `BookRequestModal`
- `BookRequestModal`: fields for title, author name, ISBN (optional), notes (optional)
- Non-admin users see a "My Requests" section showing their pending/approved/rejected requests

#### 3.5 Remove "mine"/"all" filter toggle

*Not needed.* Since all private entities are user-scoped, the user always sees only their own. No toggle required. (Admin could have a future debug view but that's out of scope.)

#### 3.6 Update types

```typescript
// lib/api.ts — add:
export interface BookRequest {
  id: string;
  title: string;
  author_name?: string;
  isbn?: string;
  notes?: string;
  status: 'pending' | 'approved' | 'rejected';
  admin_notes?: string;
  fulfilled_book_id?: string;
  created_at: string;
  updated_at: string;
}
```

No need to add `user_id` to existing entity types on the frontend — the API only returns the user's own items, so `user_id` is implicit.

---

### Phase 4 — Data migration & backfill

**Goal:** Existing content gets attributed to the admin user so tenant isolation doesn't hide existing data.

#### 4.1 Backfill existing records

After the admin's first CF Access login populates the `users` table with their real `sub` UUID:

```sql
-- Run once after first admin login
-- Replace <admin-sub> with the actual CF Access sub from the users table

UPDATE notes       SET user_id = '<admin-sub>' WHERE user_id IS NULL;
UPDATE quotes      SET user_id = '<admin-sub>' WHERE user_id IS NULL;
UPDATE thoughts    SET user_id = '<admin-sub>' WHERE user_id IS NULL;
UPDATE media       SET user_id = '<admin-sub>' WHERE user_id IS NULL;
UPDATE links       SET user_id = '<admin-sub>' WHERE user_id IS NULL;
UPDATE sleep       SET user_id = '<admin-sub>' WHERE user_id IS NULL;
UPDATE books       SET user_id = '<admin-sub>' WHERE user_id IS NULL;
UPDATE authors     SET user_id = '<admin-sub>' WHERE user_id IS NULL;
UPDATE threads     SET user_id = '<admin-sub>' WHERE user_id IS NULL;
UPDATE connections SET user_id = '<admin-sub>' WHERE user_id IS NULL;
```

#### 4.2 Add a CLI command for the backfill

```typescript
// cli/db/backfill-user-ids.ts
// Reads the admin user's sub from the users table, then updates all NULL user_id rows
```

#### 4.3 Make `user_id` NOT NULL (future migration, after backfill is confirmed)

```sql
-- 0014-user-id-not-null.sql
-- Only run after ALL rows have a user_id
-- SQLite doesn't support ALTER COLUMN, so this requires table rebuild
-- Defer this until confident all data is backfilled
```

> **Critical sequencing:** The backfill MUST run before deploying the tenant-scoped reads. Otherwise, rows with `NULL` user_id become invisible (they won't match any user's `WHERE user_id = ?`). Deploy order: backfill → then deploy scoped code.

---

### Phase 5 — Future enhancements (not in initial scope)

| Feature | Description | Priority |
|---------|-------------|----------|
| **Per-user R2 paths** | Prefix media uploads with `user_id/` for R2 organization | Medium |
| **Rate limiting** | Per-user write rate limits via CF Workers | Medium |
| **User settings** | Display name, bio, profile image, theme preference | Low |
| **Admin dashboard** | Admin view to see all users, their content counts, book requests | Low |
| **Export** | Users can export their own data (GDPR-style) | Low |
| **Public profiles** | Opt-in public profile showing selected content | Future |
| **Social features** | Following, shared threads, activity feeds | Future |

---

## Task Breakdown (implementation order)

```
Phase 1 — DB layer
  [ ] 1.1  Write migration 0013-book-requests-and-indexes.sql
  [ ] 1.2  Add mandatory userId to all get* functions for private entities in db-d1.ts
  [ ] 1.3  Add mandatory userId to all update*/delete* functions for private entities in db-d1.ts
  [ ] 1.4  Add OwnershipError class to @antisocial/core
  [ ] 1.5  Fix createConnection to accept userId
  [ ] 1.6  Move inline thought DB functions to db-d1.ts
  [ ] 1.7  Add BookRequest types, Zod schemas, and DB functions
  [ ] 1.8  Add user_id to existing Zod Row schemas
  [ ] 1.9  Export all new types from @antisocial/core

Phase 2 — API layer
  [ ] 2.1  Create helpers.ts with getUserId / getScopedUserId
  [ ] 2.2  Add authenticatedMiddleware to auth.ts
  [ ] 2.3  Update notes.ts — pass userId, swap to authenticatedMiddleware
  [ ] 2.4  Update quotes.ts — pass userId, swap to authenticatedMiddleware
  [ ] 2.5  Update thoughts.ts — use shared DB functions, pass userId
  [ ] 2.6  Update media.ts — pass userId, swap to authenticatedMiddleware
  [ ] 2.7  Update links.ts — pass userId, swap to authenticatedMiddleware
  [ ] 2.8  Update sleep.ts — pass userId, swap to authenticatedMiddleware
  [ ] 2.9  Update threads.ts — pass userId, swap to authenticatedMiddleware
  [ ] 2.10 Update connections.ts — pass userId, swap to authenticatedMiddleware
  [ ] 2.11 Router.ts — books/authors keep adminOnlyMiddleware (no change)
  [ ] 2.12 Add book-requests router (new file)
  [ ] 2.13 Handle OwnershipError → 403 in all routes

Phase 3 — Frontend
  [ ] 3.1  Add isAuthenticated / userId to useAuth composable
  [ ] 3.2  Gate capture forms on isAuthenticated instead of isAdmin
  [ ] 3.3  Gate edit/delete buttons on isAuthenticated instead of isAdmin
  [ ] 3.4  Add BookRequestModal component
  [ ] 3.5  Add "Request a Book" button to library tab (non-admin only)
  [ ] 3.6  Add "My Requests" section to library tab
  [ ] 3.7  Add admin book-requests management view
  [ ] 3.8  Add BookRequest types to lib/api.ts

Phase 4 — Data migration
  [ ] 4.1  Write CLI backfill-user-ids.ts script
  [ ] 4.2  Run backfill on staging, verify
  [ ] 4.3  Run backfill on production
  [ ] 4.4  Deploy scoped code AFTER backfill confirmed
```

---

## Files to modify

| File | Changes |
|------|---------|
| `sql/migrations/0013-book-requests-and-indexes.sql` | **New** — book_requests table + composite indexes |
| `packages/core/database/db-d1.ts` | Mandatory `userId` on private-entity functions (~25 functions); new book-request functions |
| `packages/core/database/schema.ts` | `BookRequestInput`/`BookRequestRow` Zod schemas; `user_id` in existing Row schemas |
| `packages/core/types.ts` | `BookRequest` type; `user_id` on `Thought`; `OwnershipError` class |
| `packages/core/index.ts` | Re-export new types |
| `apps/worker/api/auth.ts` | Add `authenticatedMiddleware()` |
| `apps/worker/api/helpers.ts` | **New** — `getUserId`, `getScopedUserId` |
| `apps/worker/api/book-requests.ts` | **New** — book request routes |
| `apps/worker/api/router.ts` | Mount book-requests router; books/authors unchanged |
| `apps/worker/api/notes.ts` | Pass userId, swap to `authenticatedMiddleware` |
| `apps/worker/api/quotes.ts` | Pass userId, swap to `authenticatedMiddleware` |
| `apps/worker/api/thoughts.ts` | Remove inline DB functions, pass userId, swap middleware |
| `apps/worker/api/media.ts` | Pass userId, swap to `authenticatedMiddleware` |
| `apps/worker/api/links.ts` | Pass userId, swap to `authenticatedMiddleware` |
| `apps/worker/api/sleep.ts` | Pass userId, swap to `authenticatedMiddleware` |
| `apps/worker/api/threads.ts` | Pass userId, swap to `authenticatedMiddleware` |
| `apps/worker/api/connections.ts` | Pass userId, swap to `authenticatedMiddleware` |
| `apps/web/src/lib/auth.ts` | Add `isAuthenticated`, `userId` exports |
| `apps/web/src/lib/api.ts` | Add `BookRequest` type + API functions |
| `apps/web/src/App.vue` | Gate controls on `isAuthenticated` not `isAdmin` |
| `apps/web/src/components/CaptureForm.vue` | Gate on `isAuthenticated` |
| `apps/web/src/components/BookRequestModal.vue` | **New** — book request form |
| `apps/web/src/components/FilterBar.vue` | Remove unused "all"/"mine" toggle (not needed) |
| `cli/db/backfill-user-ids.ts` | **New** — backfill script |

---

## Risk notes

1. **Deploy ordering is critical:** Backfill all `NULL` user_ids BEFORE deploying scoped reads. Otherwise existing data becomes invisible to all users.
2. **Admin bypass via `'*'` sentinel:** Simple and fast — avoids a second DB query to check role. The sentinel value is never a valid CF Access `sub` UUID.
3. **Connections edge case:** Connections link two entities that may belong to the same user. The `user_id` on a connection row indicates who created the connection. Both connected entities must also belong to that user (enforced at API level, not DB level).
4. **Threads edge case:** Thread items reference entities. A thread and all its items must belong to the same user. The API should reject `addThreadItem` if the referenced entity isn't owned by the same user.
5. **Book requests are lightweight:** No notifications system — admin checks the requests list manually. A future enhancement could add email or in-app notifications.
6. **CF Access dependency:** Every user authenticates through CF Access. No custom auth needed. No anonymous/public access to any API endpoint.
