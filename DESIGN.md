# zen-fs-remotestoragejs — Design Document

## Overview

This document describes two features to be added to `RemoteStorageFileSystem`:

1. **Snapshot** — In-memory ETag baseline for efficient `shouldSync()` implementation
2. **Precise mtime** — Sidecar files to preserve millisecond-precision mtime across sync

Both features are entirely self-contained within `zen-fs-remotestoragejs`. No changes to `zen-fs-core`, `zen-fs-sync`, or `zen-fs-config` are required.

---

## 1. Snapshot (ETag Baseline)

### 1.1 Problem

`zen-fs-sync`'s `SyncableFS` interface defines an optional method:

```typescript
shouldSync?(): Promise<boolean>;
```

> Compares the backend's saved baseline state with the actual remote state.
> Returns `true` if the remote has external changes that need syncing.
> The backend should update its internal baseline after each call.
> First call (no baseline) should initialize the baseline and return `true`.

`RemoteStorageFileSystem` currently **does not implement `shouldSync()`**. As a result, `zen-fs-sync` falls back to periodic full scans — it walks the entire file tree on both sides and compares every file's `size` and `mtimeMs` to detect changes. This is expensive for backends with many files.

### 1.2 RemoteStorage Protocol Advantage

The RemoteStorage protocol (draft-dejong-remotestorage-27) provides built-in versioning via ETags:

- Every document and folder has a strong ETag
- A document update propagates ETag changes to all ancestor folders
- A single GET request to the root folder returns a JSON-LD listing with all items' ETags

This means: **one GET to the root folder is enough to know if anything changed**. If the root folder's ETag hasn't changed, no file in the entire tree has been modified.

### 1.3 Design

Snapshot is an **in-memory `Map<path, etag>`** maintained by `RemoteStorageFileSystem`. It is not persisted to RemoteStorage — it is rebuilt from scratch on every program restart.

```
RemoteStorageFileSystem
  ├─ snapshot: Map<string, string> | null    ← path → ETag (in memory)
  ├─ rootEtag: string | null                 ← root folder's ETag
  │
  └─ shouldSync(): Promise<boolean>
       │
       ├─ snapshot === null?
       │   ├─ YES → buildSnapshot() → return true (first call, need full sync)
       │   └─ NO  → continue
       │
       ├─ HEAD root folder → get current rootEtag (1 HTTP request)
       │
       ├─ currentRootEtag === this.rootEtag?
       │   ├─ YES → return false (nothing changed)
       │   └─ NO  → buildSnapshot() → return true (something changed)
       │
       └─ (snapshot is updated as a side effect of buildSnapshot)
```

### 1.4 buildSnapshot()

```
buildSnapshot()
  │
  ├─ GET / (root folder listing, JSON-LD)
  │   Response contains root ETag + all top-level items with their ETags
  │
  ├─ this.rootEtag = response.etag
  ├─ this.snapshot = new Map()
  │
  └─ For each item in the listing:
       ├─ If item is a document (no trailing '/'):
       │   snapshot.set(itemPath, itemETag)
       │
       └─ If item is a folder (trailing '/'):
           └─ Recursively GET the folder, repeat
              (folder ETag is also stored for subtree-level comparison)
```

### 1.5 Optimization: Subtree Pruning

When `shouldSync()` detects that the root ETag has changed, it doesn't need to rebuild the entire snapshot. It can walk the tree level by level, comparing folder ETags:

```
Root ETag changed?
  └─ GET root listing
     └─ For each subfolder:
        ├─ Subfolder ETag unchanged? → Skip this subtree (no changes inside)
        └─ Subfolder ETag changed? → GET this folder, recurse
```

This minimizes HTTP requests: only changed subtrees are fetched.

### 1.6 Lifecycle

```
Program start
  └─ snapshot = null (in memory, not persisted)

First shouldSync() call
  └─ snapshot is null → buildSnapshot() → return true
     zen-fs-sync performs a full sync

Subsequent shouldSync() calls (every pollIntervalMs, default 30min)
  └─ HEAD root (1 request)
     ├─ rootEtag unchanged → return false (0 additional requests)
     └─ rootEtag changed → rebuild snapshot for changed subtrees → return true

Program restart
  └─ snapshot = null → next shouldSync() rebuilds and returns true
     zen-fs-sync's syncBidirectional compares actual file content,
     finds nothing changed, and skips. No data loss, just one extra scan.
```

### 1.7 Why Not Persist Snapshot to RemoteStorage?

1. **Not needed**: Only `RemoteStorageFileSystem` uses it; no cross-device sharing
2. **Avoids feedback loop**: Writing a snapshot file to RS would change the root ETag, causing the next `shouldSync()` to detect "changes"
3. **Simplicity**: Pure in-memory state — no consistency, crash recovery, or sidecar management

### 1.8 API

No new public API. `shouldSync()` is already part of `zen-fs-sync`'s `SyncableFS` interface. Implementing it on `RemoteStorageFileSystem` is transparent to all callers:

```typescript
class RemoteStorageFileSystem extends FileSystem {
  // ... existing methods ...

  // NEW: implement shouldSync for zen-fs-sync
  async shouldSync(): Promise<boolean> {
    if (this.snapshot === null) {
      await this.buildSnapshot();
      return true;
    }

    const currentRootEtag = await this.fetchRootEtag();
    if (currentRootEtag === this.rootEtag) {
      return false;
    }

    await this.buildSnapshot();  // rebuild baseline
    return true;
  }

  // NEW: update snapshot after a local write (called internally by writeFile/unlink)
  private updateSnapshotForPath(path: string, etag: string | null): void {
    if (this.snapshot === null) return;
    if (etag === null) {
      this.snapshot.delete(path);
    } else {
      this.snapshot.set(path, etag);
    }
    // Mark rootEtag as stale since we just modified a file
    this.rootEtag = null;
  }
}
```

### 1.9 Local Mutation Handling

When `writeFile()` or `unlink()` is called locally, the snapshot should be updated to reflect the change, so the next `shouldSync()` doesn't incorrectly report local writes as "remote changes":

```
writeFile(path, data)
  ├─ PUT to RemoteStorage
  ├─ Response contains new ETag
  └─ updateSnapshotForPath(path, responseEtag)
     ├─ snapshot.set(path, newEtag)
     └─ rootEtag = null (stale, will be refreshed on next shouldSync)

unlink(path)
  ├─ DELETE on RemoteStorage
  └─ updateSnapshotForPath(path, null)
     ├─ snapshot.delete(path)
     └─ rootEtag = null
```

---

## 2. Precise mtime

### 2.1 Problem

RemoteStorage protocol sets `Last-Modified` based on when the PUT request arrives at the server — the client cannot control it. This causes two issues:

1. **Imprecise**: Server `Last-Modified` is rounded to seconds; the original mtime may have millisecond precision
2. **Overwritten on sync**: When file A (mtime: 1700000000123) is synced to RemoteStorage, the server sets `Last-Modified` to the PUT time (e.g., 1700000005000). The original mtime is lost

`zen-fs-sync` uses `mtimeMs` in `FileSnapshot` for change detection:
```typescript
interface FileSnapshot {
  path: string;
  size: number;
  mtimeMs: number;
}
```

If mtime is overwritten by the server, the sync engine sees a "modified" file on every sync, causing unnecessary copies.

### 2.2 RemoteStorage Protocol Limitation

The RS protocol (draft-dejong-remotestorage-27) does not support:
- Custom HTTP headers on PUT (only `Content-Type` is stored)
- Client-specified `Last-Modified`
- Per-document metadata beyond ETag, Content-Type, Content-Length, Last-Modified

Therefore, precise mtime must be preserved through an **application-level sidecar file**.

### 2.3 Design: `.mtime` Sidecar

For each file at path `/foo/bar.json`, a sidecar file `/foo/.bar.json.mtime` stores the precise mtime:

```
/foo/bar.json           ← file content
/foo/.bar.json.mtime    ← { "mtime": 1700000000123 }
```

**Naming convention**: Same as zen-fs-config's `.version` sidecar pattern — prepend `.` to the filename, append `.mtime`.

```typescript
function mtimePathFor(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const mtimeFileName = `.${fileName}.mtime`;
  return dir ? `${dir}/${mtimeFileName}` : mtimeFileName;
}
```

### 2.4 Sidecar Content

```json
{
  "mtime": 1700000000123
}
```

Minimal and intentionally simple. Only `mtime` (milliseconds since epoch).

### 2.5 Integration Points

#### writeFile

```typescript
async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: {
  flag?: string;
  mtime?: number;    // NEW: optional precise mtime
}): Promise<void>
```

```
writeFile(path, data, options)
  │
  ├─ PUT file content to RemoteStorage
  │
  ├─ If preciseMtime enabled:
  │   ├─ mtime = options.mtime ?? Date.now()
  │   └─ PUT .mtime sidecar: { "mtime": mtime }
  │
  └─ Update existence cache
```

If `options.mtime` is not provided, `Date.now()` is used. This ensures that even without explicit mtime, the sidecar captures the client-side write time (which may differ from the server's `Last-Modified`).

#### writeFileWithMtime

```typescript
async writeFileWithMtime(path: string, data: string | Uint8Array | ArrayBuffer, mtime: number): Promise<void>
```

Implements the optional `SyncableFS.writeFileWithMtime` method from `zen-fs-sync`. Delegates to `writeFile(path, data, { mtime })`, which writes both the file content and the `.mtime` sidecar. The sync engine calls this method (when available) instead of `writeFile` to preserve the source file's mtime during sync. If this method is not implemented, the sync engine falls back to plain `writeFile`.

#### stat

```
stat(path)
  │
  ├─ HEAD request → get server Last-Modified, Content-Length
  │
  ├─ If preciseMtime enabled:
  │   ├─ Try to read .mtime sidecar (GET .mtime file)
  │   ├─ Sidecar exists? → use sidecar mtime (precise, millisecond)
  │   └─ Sidecar missing? → fall back to server Last-Modified (second precision)
  │
  └─ Return InodeLike with mtimeMs
```

The sidecar read adds one HTTP GET request. To minimize overhead:
- The sidecar is tiny (~30 bytes), so the request is fast
- A local memory cache can avoid repeated reads for the same path

#### touch

Currently throws "not supported". With precise mtime, it becomes functional:

```typescript
async touch(path: string, metadata: Partial<InodeLike>): Promise<void> {
  if (metadata.mtimeMs !== undefined && this.config.preciseMtime) {
    await this.writeMtimeSidecar(path, metadata.mtimeMs);
  }
  // If preciseMtime is not enabled, this is a no-op (RS doesn't support touch)
}
```

#### readFileMeta

The existing `readFileMeta()` return type is extended with an optional `preciseMtime` field:

```typescript
async readFileMeta(path: string, opts?: {
  ifNoneMatch?: string;
  ifModifiedSince?: string;
}): Promise<{
  status: number;
  data?: Uint8Array;
  etag?: string;
  lastModified?: string;      // server's Last-Modified header
  preciseMtime?: number;      // from .mtime sidecar (if enabled)
  contentType?: string;
}>
```

### 2.6 Configuration

```typescript
interface RemoteStorageConfig {
  // ... existing fields ...
  /** Enable precise mtime via .mtime sidecar files. Default: true */
  preciseMtime?: boolean;
}
```

- **Enabled (default)**: `writeFile()` creates `.mtime` sidecar files, `stat()` reads them for precise mtime, `touch()` works. This ensures `zen-fs-sync`'s `FileSnapshot` comparison is accurate — without it, server-overwritten `Last-Modified` values cause spurious "modified" detections on every sync.
- **Disabled**: No sidecar files, `stat()` returns server `Last-Modified` (second precision), `touch()` is a no-op. Useful only for read-only or non-synced scenarios where mtime precision doesn't matter.

### 2.7 readdir Behavior

`.mtime` sidecar files are **filtered out** from `readdir()` results. They are written directly to RemoteStorage by `RemoteStorageFileSystem` itself (not via zen-fs-sync), and their existence is hidden from upper layers:

```
RemoteStorage (physical):
  /documents/note.json
  /documents/.note.json.mtime     ← RSFS writes this directly via PUT

Upper layer sees (via readdir):
  /documents/
    note.json                      ← .mtime is filtered out
```

This makes sidecar files completely transparent to the upper layer:
- `readdir()` filters out any entry matching the `.mtime` sidecar pattern (`.{filename}.mtime`)
- `writeFile()` creates the sidecar directly via its own PUT request
- `stat()` reads the sidecar directly via its own GET request, then merges the mtime into the result
- `unlink()` deletes the sidecar directly via its own DELETE request

Sidecar files are never exposed to `zen-fs-sync` or `zen-fs-config`. They are an internal implementation detail of `RemoteStorageFileSystem`.

### 2.8 How mtime Propagates Across Devices

With the `writeFileWithMtime` interface, mtime propagation is now explicit:

```
Device A writes /documents/note.json at mtime=1700000000123
  → RSFS PUTs file content
  → RSFS PUTs .mtime sidecar { "mtime": 1700000000123 }

zen-fs-sync detects the file changed (via shouldSync ETag comparison)
  → syncBidirectional compares Device A (IndexedDB) with RemoteStorage
  → stat("/documents/note.json") on source → mtimeMs=1700000000123
  → readFile("/documents/note.json") on source → data
  → writeFileWithMtimeFallback(target, path, data, 1700000000123)
    → target has writeFileWithMtime? → YES → writes file + .mtime sidecar with exact mtime
    → target has writeFileWithMtime? → NO  → plain writeFile (mtime lost, but functional)

Device B reads /documents/note.json via RemoteStorageFileSystem
  → stat() HEADs the file → server Last-Modified (imprecise)
  → stat() GETs .mtime sidecar → { "mtime": 1700000000123 }
  → Returns mtimeMs = 1700000000123 (precise)
```

The key insight: `zen-fs-sync` syncs **file content** and explicitly passes the source mtime via `writeFileWithMtime`. On each device, `RemoteStorageFileSystem.stat()` reads the sidecar from RemoteStorage to return precise mtime. The sidecar lives on RemoteStorage and is accessible from any device that connects to the same storage.

### 2.9 Performance Impact

| Operation | Without preciseMtime | With preciseMtime | Delta |
|---|---|---|---|
| writeFile | 1 PUT | 2 PUT | +1 PUT (~30 bytes) |
| stat | 1 HEAD | 1 HEAD + 1 GET | +1 GET (~30 bytes) |
| readFile | 1 GET | 1 GET | unchanged |
| readdir | 1 GET | 1 GET | unchanged |
| unlink | 1 DELETE | 2 DELETE | +1 DELETE |

The sidecar is ~30 bytes, so network transfer overhead is negligible. The main cost is the additional HTTP round-trip latency.

### 2.10 Crash Recovery

If a `writeFile()` succeeds but the `.mtime` sidecar write fails (e.g., network error), the sidecar will be missing. `stat()` will fall back to the server's `Last-Modified` — less precise but not incorrect. The next `writeFile()` will recreate the sidecar.

No special crash recovery logic is needed. The system degrades gracefully.

---

## 3. Implementation Summary

### 3.1 Changes to RemoteStorageFileSystem

| Method | Change |
|---|---|
| `constructor()` | Read `config.preciseMtime` flag |
| `writeFile()` | After PUT, optionally write `.mtime` sidecar; accepts `{ mtime }` option |
| `writeFileWithMtime()` | **NEW** — implements `SyncableFS.writeFileWithMtime`; delegates to `writeFile()` with `{ mtime }` option |
| `stat()` | After HEAD, optionally read `.mtime` sidecar to override mtimeMs |
| `touch()` | Implement via sidecar write instead of throwing |
| `readFileMeta()` | Return `preciseMtime` field when available |
| `unlink()` | Also delete `.mtime` sidecar if preciseMtime enabled |
| `shouldSync()` | **NEW** — implement ETag baseline comparison |
| `buildSnapshot()` | **NEW (private)** — build ETag baseline from folder listing |
| `updateSnapshotForPath()` | **NEW (private)** — update baseline after local mutations |

### 3.2 Changes in Other Packages

The `writeFileWithMtime` interface was added to `zen-fs-sync` and implemented in `zen-fs-config` to enable mtime preservation across the entire sync stack:

| Package | Changes |
|---|---|
| `@zenfs/core` | None |
| `zen-fs-sync` | Added optional `writeFileWithMtime` to `SyncableFS` interface; added `writeFileWithMtimeFallback` helper used in `copyFile`, `syncOneWay`, `writeFileBoth` |
| `zen-fs-config` | All three adapters (`backendToSyncableFS`, `zenfsPromisesToSyncableFS`, `cachedFSToSyncableFS`) implement `writeFileWithMtime`; `backend-registry.ts` `writeFile` passes mtime through `touch()` |
| `zen-fs-cache` | None — sidecar files are regular files |

### 3.3 New Exports

No new exports needed. `shouldSync()` is discovered by `zen-fs-sync` via duck-typing on the `SyncableFS` interface. `preciseMtime` is a config option on the existing `RemoteStorageConfig`.

### 3.4 Usage Example

```typescript
import { RemoteStorageFileSystem } from 'zen-fs-remotestoragejs';

const fs = new RemoteStorageFileSystem({
  href: 'https://storage.example.com/bob',
  token: 'bearer-token',
  preciseMtime: true,    // opt-in to precise mtime
});

// writeFile automatically creates .mtime sidecar
await fs.writeFile('/documents/note.json', JSON.stringify({ text: 'hello' }));
// → PUT /documents/note.json
// → PUT /documents/.note.json.mtime  { "mtime": 1700000000123 }

// stat returns precise mtime from sidecar
const stat = await fs.stat('/documents/note.json');
console.log(stat.mtimeMs); // 1700000000123 (millisecond precision)

// shouldSync compares ETags efficiently
const changed = await fs.shouldSync();
console.log(changed); // false (nothing changed since last check)

// touch now works (writes sidecar)
await fs.touch('/documents/note.json', { mtimeMs: 1699999999000 });
```

---

## 4. Relationship to zen-fs-sync

### 4.1 How shouldSync() Integrates

```
zen-fs-sync SyncPair.watch()
  │
  ├─ Local backend (IndexedDB) → onChange callback → debounced sync
  │
  └─ Remote backend (RemoteStorageFileSystem) → poll shouldSync() every pollIntervalMs
     ├─ shouldSync() returns false → skip sync (just 1 HEAD request)
     └─ shouldSync() returns true → trigger syncAll()
        ├─ syncBidirectional() walks both file trees
        ├─ Compares FileSnapshot {path, size, mtimeMs}
        ├─ Copies changed files in both directions
        └─ (preciseMtime ensures mtimeMs comparison is accurate)
```

### 4.2 How preciseMtime Helps Sync

Without precise mtime:
```
File written on Device A at mtime=1700000000123
  → synced to RemoteStorage, server sets Last-Modified=1700000005000
  → synced to Device B, B sees mtime=1700000005000
  → next sync: A has 1700000000123, B has 1700000005000
  → sync engine thinks file is "modified" → unnecessary copy
```

With precise mtime:
```
File written on Device A at mtime=1700000000123
  → .mtime sidecar: { "mtime": 1700000000123 }
  → synced to RemoteStorage (content + sidecar)
  → synced to Device B (content + sidecar)
  → next sync: A has 1700000000123, B has 1700000000123
  → sync engine: unchanged → skip
```

---

## 5. Limitations and Future Work

### 5.1 Snapshot Limitations

- **In-memory only**: Lost on restart. First `shouldSync()` after restart returns `true`, triggering a full sync scan. This is acceptable — `syncBidirectional` will find no actual changes and skip quickly.
- **No partial snapshot**: The entire file tree is scanned when the root ETag changes. For very large trees, subtree pruning (§1.5) limits the scan to changed subtrees.

### 5.2 Precise mtime Limitations

- **Extra HTTP requests**: Each `writeFile` and `stat` requires one additional request. For write-heavy workloads, consider batching sidecar updates.
- **Sidecar visibility**: `.mtime` files appear in `readdir()`. Callers must filter if needed.
- **Non-atomic writes**: File content and sidecar are written in separate PUTs. A crash between them leaves the sidecar missing. Graceful fallback to server `Last-Modified` handles this.

### 5.3 Future: Batch mtime Manifest

Instead of one sidecar per file, a single manifest file per directory could batch all mtimes:

```
/foo/.mtime-manifest.json    ← { "bar.json": 1700000000123, "baz.json": 1699999999000 }
```

This reduces HTTP requests (1 per directory instead of 1 per file) at the cost of more complex update logic. Can be considered as a future optimization if per-file sidecars prove too chatty.
