# t3code Thread/Chat Loading and Startup Performance Research

## Scope and source

I inspected the public repository at:

- `https://github.com/pingdotgg/t3code`
- Local checkout used for source inspection: `/tmp/t3code-full`
- HEAD inspected: `8b817cbca` (`fix(web): use circle alert for failed tool calls`)

The repository contains the current orchestration implementation, client runtime, server persistence code, and git history for the relevant performance work. The most relevant areas are:

- `packages/client-runtime/src/state/`
- `apps/web/src/connection/`
- `apps/web/src/components/`
- `apps/server/src/orchestration/`
- `apps/server/src/persistence/`
- `packages/contracts/src/orchestration.ts`

This report addresses:

1. What is loaded at startup.
2. Whether the UI is seeded with a tail and older history is paged.
3. How transcripts are stored on disk.
4. Whether there is a client-side persisted cache/projection.
5. How the sidebar stays cheap.
6. Cursors and sequence numbers for live-stream resumption.

It concludes with the applicability of these techniques to a tail-seed + cursor-resume + paged-history design.

## Architecture summary

`t3code` has converged on a split shell/detail architecture:

1. **Shell snapshot**
   - Contains projects and lightweight thread metadata.
   - Populates the sidebar.
   - Does not hydrate every thread's messages and activities.

2. **Selected-thread detail**
   - Loaded independently from the shell.
   - Uses a bounded recent window when pagination is supported.
   - Loads older turns on demand.

3. **Client-side persisted cache**
   - Shell snapshots and thread-detail snapshots are stored in IndexedDB in the web renderer.
   - Cached data is rendered immediately at relaunch.
   - Cached snapshots include sequence state, allowing live synchronization to resume without redownloading the thread body.

4. **Server-side projections**
   - The server has an append-oriented orchestration event store plus SQLite projection tables.
   - Messages, turns, activities, sessions, plans, and shell metadata are projected into separate relational tables.
   - Windowed detail queries use SQL keyset pagination, rather than reading and decoding the complete thread before trimming it.

5. **Live stream resume**
   - Shell and thread subscriptions accept `afterSequence`.
   - The server replays events after that sequence and then emits live events.
   - Snapshot responses expose sequence watermarks so HTTP snapshot loading and WebSocket/live-stream handoff can be reconciled safely.

The central performance principle is to separate **what is needed to list threads** from **what is needed to render one transcript**, then separately bound the transcript read itself.

---

## 1. What does t3code load at startup?

### Sidebar: shell metadata, not complete thread histories

The sidebar is backed by a shell snapshot. The server explicitly separates this from a fully hydrated orchestration snapshot.

#### Server route

`apps/server/src/orchestration/http.ts` contains the `snapshot`, `shellSnapshot`, and `threadSnapshot` handlers.

The `snapshot` handler explains why it uses a lightweight read model:

> “Serve the lightweight command read model (thread bodies empty) instead of the fully hydrated snapshot. Hydrating every message and activity payload in the database has OOM-killed servers…”

The UI-facing `shellSnapshot` handler calls:

```ts
projectionSnapshotQuery.getShellSnapshot()
```

The shell contains project and thread-shell metadata such as:

- thread id
- title
- project id
- created/updated timestamps
- model selection
- branch/worktree information
- latest-turn/session state
- settled/running/pinned/archive state

It does not include every thread's complete message history.

#### Client shell startup

`packages/client-runtime/src/state/shell.ts` contains `makeEnvironmentShellState`.

The shell state machine:

1. Loads a cached shell with `cache.loadShell(environmentId)`.
2. Immediately initializes shell state with that cached value and status `"cached"` when present.
3. Starts a debounced persistence queue.
4. Loads the authoritative shell snapshot over HTTP where possible.
5. Uses the socket stream for synchronization and live updates.

Relevant initialization shape:

```ts
const cachedSnapshot = yield* cache.loadShell(environmentId);

const state = yield* SubscriptionRef.make<EnvironmentShellState>({
  snapshot: cachedSnapshot,
  status: shellStatusForSnapshot(cachedSnapshot),
  error: Option.none(),
});
```

This lets the sidebar render from disk before the network request completes.

### Selected thread: one detail attachment

`packages/client-runtime/src/state/threads.ts` contains `makeEnvironmentThreadState`.

For a thread state machine, startup is:

1. Load the cached detail snapshot.
2. Publish the cached thread immediately if one exists.
3. Read its cached `snapshotSequence`.
4. Fetch an HTTP snapshot if necessary.
5. Open or resume the thread stream using `afterSequence`.

The implementation does not load the top N complete session histories at startup. It loads the selected/attached thread and optionally prewarms a small number of visible sidebar threads.

### Sidebar prewarming: capped at three

`apps/web/src/components/Sidebar.logic.ts` defines:

```ts
export const SIDEBAR_THREAD_PREWARM_LIMIT = 3;
```

`getSidebarThreadIdsToPrewarm()` returns only the first three visible thread IDs. `apps/web/src/components/LegacySidebar.tsx`, around the prewarm computation, derives the corresponding scoped thread refs and renders those subscriptions.

The source comment is important: prewarming is not just metadata. Each prewarmed thread can hold a live, fully hydrated detail subscription while visible. Therefore the limit is a direct renderer-heap and server-load multiplier.

The practical startup behavior is therefore:

- load cached shell metadata for the sidebar;
- attach the selected thread in detail;
- optionally detail-prewarm up to three visible threads;
- do not hydrate every sidebar row or the top N full histories.

### Answer to point 1

`t3code` starts with a lightweight shell/session list, then attaches the selected thread. It has a small optional prewarm of three visible threads, but does not cold-load all session histories or a large top-N set.

---

## 2. Does it seed the UI with a tail and page older data?

Yes. This is one of the clearest techniques in the repository.

### Initial recent-turn window

`packages/client-runtime/src/state/threads.ts` defines:

```ts
export const INITIAL_THREAD_USER_TURN_LIMIT = 10;
export const OLDER_THREAD_PAGE_USER_TURN_LIMIT = 20;
```

The comments describe the policy:

- initial page: the last 10 user-anchored turns;
- each older-history request: 20 more user-anchored turns;
- subagent/fan-out turns associated with those user turns ride along.

This is turn-based rather than arbitrary-message pagination. It preserves conversation structure better than selecting the last N raw messages, especially when a turn includes tool calls, activities, delegated work, or multiple assistant segments.

### HTTP initial load

`packages/client-runtime/src/state/threadSnapshotHttp.ts` defines:

```ts
export interface ThreadSnapshotWindow {
  readonly turnLimit: number;
  readonly beforeCursor?: string;
}
```

The loader sends the window to:

```text
GET /api/orchestration/threads/:threadId
```

When the server advertises pagination support, the initial request passes:

```ts
{ turnLimit: INITIAL_THREAD_USER_TURN_LIMIT }
```

The loader is capability-gated so older servers that do not understand the window parameters are not accidentally given a partial transcript they cannot page.

### Older-page loading

`packages/client-runtime/src/state/threads.ts` owns the live per-thread state machine and older-page integration.

It stores page metadata including:

- `beforeCursor`
- `hasMore`
- `loadingOlder`

It exposes:

```ts
requestOlderThreadTurns(environmentId, threadId)
```

The older-page path:

1. Requests the next page through a registry/queue.
2. Avoids starting a second fetch while one is active.
3. Fetches using the opaque `beforeCursor`.
4. Merges the result into the current transcript.
5. Handles stale results after reconnect, revert, deletion, or snapshot replacement.

The comments describe a sliding queue and serial processing so repeated “load earlier” actions are coalesced.

### Page/live race handling

The page response carries a thread sequence watermark. If an older page was read ahead of the live subscription, the client parks the response until the live stream catches up.

The relevant logic in `packages/client-runtime/src/state/threads.ts` checks whether:

```ts
watermark !== undefined && watermark > loadedSequence
```

If so, the page is held in `pendingOlderPage` rather than immediately merged. This prevents the following duplication bug:

1. HTTP page includes a recent update not yet delivered by the stream.
2. Client merges the page.
3. Stream later replays the same update.
4. The update is applied twice or text is duplicated.

The state machine also uses a `historyEpoch` and an `applyLock` to discard or serialize responses when history has been rewritten.

### Server contract

`packages/contracts/src/orchestration.ts` defines:

- `OrchestrationThreadDetailWindow`
- `OrchestrationThreadDetailPage`
- `OrchestrationThreadDetailSnapshot`

The window accepts:

```ts
turnLimit
beforeCursor
```

The response page includes:

```ts
beforeCursor
hasMore
snapshotSequence
threadSequence
```

The contract describes `beforeCursor` as opaque and exclusive, returning a disjoint slice of older turns.

### Answer to point 2

Yes. t3code seeds the selected thread with the last 10 semantic/user-anchored turns, then loads 20 older turns at a time when the user scrolls back. It pages by turns, not arbitrary messages, and handles ordering/race issues when live stream data overlaps an HTTP page.

---

## 3. How are transcripts stored on disk?

There are two persistence layers: server-side durable projections/event history and renderer-side cached snapshots.

### Server: SQLite projections plus orchestration event store

#### Event store

`apps/server/src/persistence/Layers/OrchestrationEventStore.ts` owns persisted orchestration event reads and writes.

It supports bounded replay from an exclusive sequence cursor:

```ts
readFromSequence(sequenceExclusive, limit)
```

Reads are fixed-size/bounded internally rather than requiring an unbounded event-store read.

The event store is the authoritative append/replay source for synchronization and recovery.

#### Relational projections

`apps/server/src/persistence/Migrations/005_Projections.ts` creates tables including:

- `projection_projects`
- `projection_threads`
- `projection_thread_messages`
- `projection_thread_activities`
- `projection_thread_sessions`
- `projection_turns`
- `projection_pending_approvals`
- other thread-related projection tables

The message table is row-based, not one file per message. The turn table is separate, which enables pagination at conversation-turn granularity.

The initial schema includes fields such as:

```sql
CREATE TABLE IF NOT EXISTS projection_thread_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  is_streaming INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

`apps/server/src/persistence/Layers/ProjectionThreadMessages.ts` provides row-level upsert, get, list, and delete operations.

The generic repository has a full list query ordered by `created_at` and `message_id`, but the bounded orchestration route does not need to read/decode all historical rows for an ordinary initial open.

### SQL keyset pagination

`apps/server/src/persistence/Migrations/037_ProjectionTurnsKeysetIndex.ts` adds:

```sql
CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_keyset
ON projection_turns(thread_id, requested_at, turn_id)
```

The migration explains that the existing index could force SQLite to build a temporary B-tree over all turns before applying `LIMIT`. The composite index makes the candidate scan genuinely bounded by the requested page.

`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` implements the windowed detail query. It:

- selects a bounded recent turn window;
- uses a stable `(requested_at, turn_id)` keyset boundary;
- restricts messages, activities, plans, and related objects to the selected page plus necessary live/control state;
- emits page metadata and a stable cursor.

This distinction matters: it is not sufficient to fetch the whole transcript and slice it in application memory. t3code has recent performance work specifically to bound the SQL read before decoding/serialization.

### Stable opaque history cursor

`apps/server/src/orchestration/threadDetailCursor.ts` defines the cursor payload:

```ts
{
  threadId,
  beforeAnchorAt,
  beforeTurnId
}
```

The cursor documentation explicitly rejects using `projection_turns.row_id`, because row IDs can be rewritten by revert projector delete/reinsert operations and by projection rebuilds. The `(anchor timestamp, turn id)` pair is derived from event content and survives those operations better.

### Answer to point 3

The server stores transcripts in SQLite relational projection tables, backed by an append-oriented orchestration event store. It does not use per-message files, SQLite blobs per page, or an append-log-only client format. Older history is read through indexed keyset queries over projected turns.

---

## 4. Is there a client-side persisted cache/projection?

Yes.

### IndexedDB stores

`apps/web/src/connection/storage.ts` defines IndexedDB object stores including:

```ts
const SHELL_STORE_NAME = "shell";
const THREAD_STORE_NAME = "thread";
```

The stores are created during database initialization. Thread entries use scoped keys:

```ts
function threadCacheKey(environmentId, threadId) {
  return `${environmentId}:${threadId}`;
}
```

The stored values are encoded and schema-validated snapshots, not individual message records.

Thread snapshots include:

- the projected thread detail;
- page metadata when the snapshot is windowed;
- the snapshot sequence;
- related detail collections included by the server response.

The current persisted wrapper uses `schemaVersion: 3` for stored thread snapshots.

### Immediate cached paint

`packages/client-runtime/src/state/threads.ts` loads the cache before establishing the live subscription:

```ts
const cached = yield* cache.loadThread(environmentId, threadId)
```

It initializes state from the cached data:

```ts
const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
  data: cachedThread,
  status: statusWithoutLiveData(cachedThread),
  error: Option.none(),
  page: Option.flatMap(cached, (snapshot) => pageStateFromSnapshot(snapshot.page)),
});
```

Thus a relaunch can show the cached tail immediately without requesting or replaying the complete transcript.

### Cached sequence and resume

The same cached snapshot supplies:

```ts
snapshot.snapshotSequence
```

The state machine initializes its `lastSequence` from that value and later sends it as `afterSequence` when subscribing.

This is the important combination:

> persisted visible projection + persisted server sequence

The client does not have to redownload the complete history merely to discover what changed since the last launch.

### Debounced writes

Both shell and thread state machines persist through a sliding queue and debounce writes for approximately 500 ms. This prevents every streaming delta from causing an IndexedDB write and keeps persistence work off the critical render path.

### Cache and pagination compatibility

The cached thread snapshot retains its `page` metadata and cursor. The client can therefore render the cached tail and continue loading older pages from the same point.

The implementation also handles capability changes: if a cached windowed snapshot reconnects to a server that does not advertise pagination, it drops the partial-window marker/data and falls back to a full reload path rather than pretending the partial cache is complete forever.

### Answer to point 4

Yes. t3code persists shell and per-thread projected snapshots in IndexedDB, including page state and sequence watermarks. It uses the cache for immediate paint, then resumes synchronization from the cached sequence.

---

## 5. How does the sidebar stay cheap?

### Separate shell endpoint and read model

The sidebar uses a dedicated shell path rather than hydrating every thread.

Relevant files:

- `apps/server/src/orchestration/http.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `packages/client-runtime/src/state/shell.ts`
- `packages/client-runtime/src/state/shellSnapshotHttp.ts`

The shell route returns projects and thread-shell metadata without all messages, activities, plans, and other detail payloads.

`ProjectionSnapshotQuery` exposes distinct operations such as:

- `getShellSnapshot()`
- `getArchivedShellSnapshot()`
- `getThreadShellById()`
- `getThreadDetailSnapshot()`
- `getCommandReadModel()`

This allows sidebar queries to remain cheap and lets detail requests be targeted to one thread.

### Active-only and bounded shell snapshots

Commit `7839c0e38` (2026-08-15) is titled:

```text
perf(server): keep shell snapshots bounded and active-only
```

It changed shell snapshot/query/stream behavior and related client shell handling. The design keeps the main shell bounded, avoids putting archived/non-active material into the primary shell payload, and uses separate loading/synchronization for data that is not needed by the normal sidebar.

The commit touched, among other files:

- `apps/server/src/orchestration-v2/ProjectionStore.ts`
- `apps/server/src/orchestration-v2/ShellStream.ts`
- `apps/server/src/orchestration-v2/http.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `apps/server/src/ws.ts`
- `packages/client-runtime/src/state/shellReducer.ts`

### Shell cache

`packages/client-runtime/src/state/shell.ts` loads a cached shell before the network. `apps/web/src/connection/storage.ts` stores it in the IndexedDB `shell` store.

This means even the sidebar's first paint does not require reconstructing the complete shell from disk/network every time.

### Small prewarm limit

`SIDEBAR_THREAD_PREWARM_LIMIT = 3` is intentionally conservative. The rest of the sidebar remains shell-only until selected or otherwise needed.

### Answer to point 5

The sidebar is cheap because it uses summary/shell rows, a separate active/bounded shell snapshot, a cached shell projection, and only a very small detail prewarm budget. It does not treat the sidebar list as a reason to load complete transcripts.

---

## 6. Does it use cursors or sequence numbers for live-stream resumption?

Yes, at both the event-stream level and the history-pagination level.

### Event sequence for shell/thread stream resumption

`packages/contracts/src/orchestration.ts` defines `afterSequence` on both subscription inputs.

For `OrchestrationSubscribeShellInput`:

```ts
afterSequence?: number
```

The contract says that when provided, the server skips the initial full shell snapshot and replays shell events after the supplied sequence.

For `OrchestrationSubscribeThreadInput`:

```ts
afterSequence?: number
```

The server similarly replays thread events after that sequence, then transitions to live events.

The event store implementation is in:

- `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`
- `apps/server/src/persistence/Services/OrchestrationEventStore.ts`

The replay API uses an exclusive sequence cursor and bounded limits.

### Snapshot sequence

`OrchestrationThreadDetailSnapshot` includes:

```ts
snapshotSequence
```

The client stores that value with its cached projection and later uses it as its resume point.

### Thread-scoped watermark

Windowed detail pages additionally include:

```ts
threadSequence
```

The contract documents why a thread-scoped watermark is needed: the global snapshot sequence advances for events belonging to every thread, while the per-thread stream only receives events for one thread. The watermark lets the client determine whether an HTTP page is ahead of the live per-thread stream.

### Completion markers

The subscription inputs also support:

```ts
requestCompletionMarker?: boolean
```

This requests an explicit marker after the initial snapshot/catch-up replay and before live events begin.

It lets client state distinguish:

- cached data;
- snapshot or cursor catch-up;
- genuinely live state.

That is useful for avoiding a misleading “running” or “loading” indication merely because a replay is in progress.

### Stable history cursor

`apps/server/src/orchestration/threadDetailCursor.ts` uses an opaque cursor based on:

```ts
threadId
beforeAnchorAt
beforeTurnId
```

The cursor is exclusive and thread-bound. The thread ID prevents accidental use against another thread. The stable content-derived boundary is preferred over mutable database row IDs.

### Answer to point 6

Yes. t3code uses durable event sequence numbers for live-stream resume, stable opaque keyset cursors for older-history pagination, and a thread-scoped watermark to merge HTTP pages with per-thread live events safely.

---

## Commit history and performance work

The public git history contains a clear series of thread-loading and startup-performance changes.

### `a91e4a5de` — 2026-08-13

```text
feat(orchestration): bound thread history and resume payloads
```

This introduced the main bounded-history architecture across:

- server thread paging;
- client thread state;
- HTTP snapshot loading;
- page merge logic;
- WebSocket fallback behavior;
- mobile/web timeline behavior;
- cursor and resume contracts.

The commit added or changed modules including:

- `apps/server/src/orchestration-v2/threadHistoryPaging.ts`
- `apps/server/src/orchestration-v2/threadHistoryPaging.test.ts`
- `packages/client-runtime/src/state/threadHistoryController.ts`
- `packages/client-runtime/src/state/threadHistoryHttp.ts`
- `packages/client-runtime/src/state/threadHistoryMerge.ts`
- `packages/client-runtime/src/state/boundedThreadSnapshotHttp.ts`
- `packages/client-runtime/src/state/threadSnapshotHttp.ts`
- `packages/client-runtime/src/state/threads.ts`
- `packages/client-runtime/src/state/threadDetail.ts`
- `packages/contracts/src/orchestrationV2.ts`
- web/mobile timeline and stream modules

The commit also added extensive tests for pagination, merge behavior, stream resumption, and bounded snapshot loading.

### `7839c0e38` — 2026-08-15

```text
perf(server): keep shell snapshots bounded and active-only
```

This focused on reducing shell snapshot size and avoiding full/archived data in the primary shell path. It changed shell streaming, projection queries, HTTP/WebSocket behavior, and client shell reduction.

### `2aa1e946c` — 2026-08-29

```text
perf(orchestration): bound history reads in SQL
```

The commit message states:

> “Load at most one turn-item page per thread in a fork lineage before decoding, keyed by the stable history cursor. Restrict message, plan, and handoff reads to that page plus live actionable state so cold opens and older-page requests no longer decode complete historical tables.”

This is especially relevant to an app that currently replays a full event history on cold attach. The important change is below application-level slicing: SQL itself is restricted to the requested page before decoding and serialization.

### `e194da46b` — 2026-08-29

```text
perf(orchestration): bound complete thread snapshots
```

The commit message states:

> “Budget the serialized bounded projection after retaining live control state. Cap historical control arrays and large plan or handoff details only on the bounded route; the full thread-detail route remains available for complete text.”

This adds a payload-budgeting layer on top of bounded history reads. Large historical control data is capped on the bounded route while live control state remains available.

### Other related commits

- `f43e4ae6b` — `perf(orchestration): per-thread shell deltas, visit throttling, event compaction (#4971)`
- `46aa94df2` — `fix(relay): stop replaying the whole event store into the awareness relay`
- `760bb460d` — `perf(web): keep timeline minimap animations off the main thread`

These show that the project addressed not only transcript size but also shell delta behavior, unnecessary relay replay, visit/subscription pressure, and renderer work.

### PRs and release notes

The repository's local git history provided concrete performance commits and their full source changes. I did not find a separate current public release-note document specifically dedicated to thread-load performance. The historical internal performance-regression document was added in commit `a91e4a5de`, but was not present at the inspected HEAD path in the checkout. The source and commit metadata independently confirm the mechanisms described above.

---

## Mapping to a tail-seed + cursor-resume + paged-history design

| t3code technique | Mapping to our Electrobun + React + local HTTP/SSE app |
|---|---|
| Dedicated shell snapshot | Keep sidebar session rows as summaries: ID, title, timestamps, status, latest-turn preview, unread/busy state. Do not load transcripts for the sidebar. |
| Selected-thread detail subscription | Attach only the selected session at startup. Avoid loading the top N full histories. |
| Three-thread prewarm | Optional only. If used, keep it very small and measure heap/server load. It is not required for the core design. |
| Initial 10 user-turn window | Seed the selected transcript with a tail measured in semantic turns, not arbitrary event/message count. |
| 20-turn older pages | Add `beforeCursor`/`hasMore` and fetch older history when the user scrolls to the top. |
| SQLite projection tables | Keep the server event log authoritative, but add/query a materialized session projection so cold reads do not rebuild the transcript from every event. |
| SQL keyset index | Index by session plus stable ordering fields. Avoid `OFFSET`; use keyset pagination. |
| IndexedDB cached snapshot | Persist the newest visible projection, page cursor, and sequence watermark client-side. Render it before network synchronization. |
| `afterSequence` stream resume | Open SSE from the cached sequence instead of replaying from event zero. |
| Thread/session-scoped watermark | Include a per-session sequence/watermark so a paged HTTP response can be safely merged with SSE events. |
| Completion marker | Explicitly distinguish replay/catch-up from a genuinely active run. |
| Opaque stable history cursor | Base the cursor on stable event/content ordering, not mutable database row IDs. |
| Stale-page epoch and merge lock | Guard page responses against reconnect, rewind, deletion, or transcript replacement races. |
| Debounced cache writes | Coalesce stream deltas before persisting the client projection. |

### Recommended implementation sequence for our app

For the current full-event-history cold attach behavior, the closest t3code-inspired sequence is:

1. Load cached sidebar shell/session summaries.
2. Attach only the selected session.
3. Load a cached selected-session tail, if available.
4. If no cache exists, request a bounded tail such as the last 10 semantic turns.
5. Start SSE with `afterSequence = cachedSequence` or the HTTP tail's sequence.
6. Reconcile SSE events into the cached projection.
7. When the user scrolls to the top, request older pages with an opaque keyset cursor.
8. Persist the newest projection, page state, and sequence after debounced updates.
9. Keep a full-history endpoint only for export, debugging, or an explicit “load all” action.

### Important design cautions

- Page by semantic turns or other transcript units that preserve tool/delegation ordering; do not blindly page raw messages if that can separate a tool call from its result.
- Bound the SQL query before decoding/serialization. Fetching the full event table and slicing in JavaScript preserves the cold-start problem.
- Treat the cached projection as a visible starting point, not authoritative completion. Reconcile it from the server using the cached cursor.
- Keep server sequence and history-page cursor conceptually separate: one resumes live events; the other walks older durable history.
- Guard asynchronous page/live merges against rewinds, deletions, reconnects, and stale attachment generations.
- Do not infer that a session is running solely because the client is replaying or catching up.

---

## Blockers and workarounds

### 1. Initial partial clone was unusable

Attempted workaround 1:

```text
git clone --filter=blob:none --no-checkout https://github.com/pingdotgg/t3code.git /tmp/t3code
```

The clone completed, but checkout failed because required promisor objects were missing. Git reported missing objects and repository/object corruption while attempting to materialize `HEAD`.

Attempted workaround 2:

```text
git clone https://github.com/pingdotgg/t3code.git /tmp/t3code-full
```

The full clone completed successfully and was used for all source inspection, searches, and git-history review.

### 2. Historical performance document unavailable at current HEAD

I attempted to read:

```text
docs/internals/performance-regressions.md
```

It was not present at the current checkout's HEAD path. I then inspected commit `a91e4a5de`'s file list and commit metadata, where the document was introduced, and verified the relevant mechanisms directly in current source files and tests.

The report therefore does not claim current-HEAD contents for that historical document; the performance conclusions are based on source and commit data that were available and independently confirmed.

### 3. No separate external PR/release-note browsing

The local public git history was available and contained concrete performance commit messages, dates, changed files, and implementation details. I did not find or independently verify additional PR discussion or release-note claims outside that git history, so none are presented as verified here.

---

## Bottom line

`t3code` addresses cold chat loading with four mutually reinforcing techniques:

1. lightweight shell/sidebar snapshots;
2. cached projected thread tails;
3. bounded, turn-based keyset history pages;
4. sequence-based live-stream resume.

The closest adaptation for our app is not merely “cache the last N messages.” It is:

> Persist a coherent tail projection and its server cursor, attach only the selected session, resume SSE from that cursor, and page older semantic turns from an indexed server-side projection using a stable opaque history cursor.
