# Threads — Named Ordered Collections

Threads are named, ordered collections of Notes, Thoughts, Quotes, and Books.
They get a dedicated tab, explicit drag-to-reorder, and items are added via an
action button on each entity card.

## Architecture

A dedicated `threads` table + `thread_items` join table (not reusing
`connections`, which is pairwise and unordered). Items carry a `position`
integer for explicit ordering and an `entity_type`/`entity_id` polymorphic
reference.

## Steps

### 1. SQL Migration

Create `sql/migrations/0011_threads.sql`:

- `threads` table: `id TEXT PK`, `name TEXT NOT NULL`, `description TEXT`,
  `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`
- `thread_items` table: `id TEXT PK`,
  `thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE`,
  `entity_type TEXT NOT NULL`, `entity_id TEXT NOT NULL`,
  `position INTEGER NOT NULL DEFAULT 0`, `added_at TEXT NOT NULL`
- UNIQUE constraint on `(thread_id, entity_type, entity_id)` — no duplicate
  items
- Indexes on `thread_id` and `(entity_type, entity_id)` (reverse lookup — "which
  threads is this note in?")

### 2. Setup Schema

Create `cli/setup/schema/007-threads.sql` mirroring the migration for fresh
installs.

### 3. Core DB Functions

Add to `packages/core/database/db-d1.ts`:

- `createThread(db, { name, description })` → returns thread
- `updateThread(db, id, { name?, description? })` → partial update
- `deleteThread(db, id)` → cascade deletes items
- `getThreads(db, { limit?, offset?, search? })` → list threads with item count
- `getThreadById(db, id)` → single thread
- `getThreadItems(db, threadId)` → ordered items (`ORDER BY position`)
- `addThreadItem(db, threadId, entityType, entityId)` → inserts with
  `position = MAX(position) + 1`
- `removeThreadItem(db, threadId, entityType, entityId)` → deletes + reorders
- `reorderThreadItems(db, threadId, items: { entityType, entityId, position }[])`
  → batch update positions
- `getThreadsForEntity(db, entityType, entityId)` → reverse lookup

### 4. Core Schema Types

Add to `packages/core/database/schema.ts`:

- `ThreadRow` and `ThreadInput` Zod schemas
- `ThreadItemRow` and `ThreadItemInput` Zod schemas

### 5. API Router

Create `apps/worker/api/threads.ts`:

- `GET /threads` — list threads (with item counts)
- `GET /threads/:id` — single thread with items
- `POST /threads` — create thread
- `PATCH /threads/:id` — update name/description
- `DELETE /threads/:id` — delete thread
- `POST /threads/:id/items` — add item (`{ entity_type, entity_id }`)
- `DELETE /threads/:id/items/:itemId` — remove item
- `PUT /threads/:id/items/reorder` — batch reorder
  (`{ items: [{ entity_type, entity_id, position }] }`)
- Mount in `apps/worker/api/router.ts` as `app.route('/threads', threadsRouter)`

### 6. Client API

Add to `apps/web/src/lib/api.ts`:

- `Thread` and `ThreadItem` interfaces
- `fetchThreads()`, `fetchThread(id)`, `createThread(input)`,
  `updateThread(id, input)`, `deleteThread(id)`
- `addThreadItem(threadId, entityType, entityId)`,
  `removeThreadItem(threadId, itemId)`, `reorderThreadItems(threadId, items)`
- `fetchThreadsForEntity(entityType, entityId)` — for showing thread badges on
  cards

### 7. "Add to Thread" Modal

Create `AddToThreadModal.vue`:

- Triggered from action buttons on `NoteItem`, `QuoteItem`, `ThoughtItem`, and
  book cards
- Lists existing threads with checkboxes (pre-checked if entity is already in
  thread)
- "New Thread" inline input to create + add in one step
- Props: `entityType`, `entityId`, `isOpen`; emits `close`, `updated`

### 8. Update Entity Cards

Add a "thread" action button to:

- `NoteItem.vue` — new emit `(e: 'addToThread', note: Note)`
- `QuoteItem.vue` — same pattern
- Thought item component — same pattern
- Book cards in the Library tab — same pattern

Each card also shows small thread badges (pill with thread name) if the entity
belongs to any threads.

### 9. Threads Tab

New tab value `'threads'` in `App.vue`:

- **Thread list view**: Shows all threads as cards with name, description
  preview, item count, and creation date. "New Thread" button at top.
- **Thread detail view** (inline, not a separate route): Clicking a thread opens
  the detail — shows name (editable inline), description, and ordered items
  rendered as their native card types (`NoteItem`, `QuoteItem`, etc.) with drag
  handles. Back button returns to list.
- Add the tab to `AppHeader.vue`

### 10. Drag-to-Reorder

Inside thread detail view:

- Use a lightweight drag library or native HTML5 drag (Vue's
  `@dragstart`/`@dragover`/`@drop` events with position tracking)
- On drop, call `reorderThreadItems` API with new position array
- Each item shows a drag handle (grip dots icon) on the left

### 11. Thread Card Component

Create `ThreadCard.vue`:

- Displays thread name, description snippet, item count by type (e.g., "3 notes,
  1 quote, 2 books"), creation date
- Click opens detail view
- Edit/delete actions on hover

### 12. Thread Detail Component

Create `ThreadDetail.vue`:

- Header: editable thread name, description, "Back" button
- Body: ordered list of items, each rendered as the appropriate entity card with
  a drag handle and a remove button
- Uses a `resolveThreadItems` function that batch-fetches entities by type/ID

## Verification

- Create a thread, add notes/quotes/thoughts/books from their respective cards
- Verify items appear in order in the thread detail view
- Drag to reorder, refresh, confirm order persists
- Remove items, verify they're gone from thread but still exist as entities
- Delete a thread, confirm items are unaffected
- Run `npm run typecheck` for TS validation

## Design Decisions

- **Dedicated tables over connections**: Threads need ordering + a name, which
  the flat pairwise `connections` table can't cleanly represent
- **Cascade delete on thread_items**: Deleting a thread removes its item
  associations but not the underlying entities
- **No EntityType addition**: Threads are a structural/organizational concept,
  not a content entity — they don't participate in the connections graph
- **Position integers with gap-free reindex on reorder**: Simpler than
  fractional positioning for the expected scale
