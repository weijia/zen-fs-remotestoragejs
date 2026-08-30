# zen-fs-remotestoragejs

A [ZenFS](https://github.com/weijia/zen-fs) backend for [RemoteStorage](https://remotestorage.io/)-compatible storage servers. Provides a full FileSystem interface over HTTP, with smart caching, ETag-based change detection, and optimized sync support.

## Features

- **Full FileSystem API** — `readFile`, `writeFile`, `stat`, `readdir`, `mkdir`, `unlink`, `rmdir`, and more
- **Smart caching** — directory listing cache with ETag-based invalidation, existence cache, and persistent storage (localStorage / file)
- **Optimized for sync** — implements `shouldSync()` with root ETag check + snapshot-based subtree pruning, so most sync checks need just 1 HTTP request
- **Precise mtime** — millisecond-accurate modification times via `.mtime` sidecar files (invisible to upper layers)
- **Auto-retry** — built-in retry with backoff for transient network errors
- **Browser & Node.js** — works in both environments with no code changes
- **Standard RemoteStorage protocol** — compatible with any RemoteStorage-compatible server (5apps, own instance, etc.)

## Installation

```bash
npm install zen-fs-remotestoragejs
```

> Requires `@zenfs/core >= 2.3.3`.

## Usage

### Basic setup

```typescript
import {
  RemoteStorageFileSystem,
  createRemoteStorageFileSystem,
} from 'zen-fs-remotestoragejs';

// Recommended factory function:
const fs = createRemoteStorageFileSystem({
  href: 'https://storage.5apps.com/',
  token: 'your-bearer-token',
  basePath: '/public/', // optional, scopes all operations
});

// Or instantiate directly:
const fs2 = new RemoteStorageFileSystem({
  href: 'https://example.com/storage/',
  token: 'your-token',
});
```

### With ZenFS configure

```typescript
import { configure, fs } from '@zenfs/core';
import { RemoteStorageFileSystem } from 'zen-fs-remotestoragejs';

await configure({
  mounts: {
    '/remote': {
      backend: RemoteStorageFileSystem,
      href: 'https://storage.5apps.com/',
      token: 'your-token',
      basePath: '/public/',
    },
  },
});

// Read a file
const data = await fs.promises.readFile('/remote/notes.txt', 'utf-8');

// Write a file
await fs.promises.writeFile('/remote/notes.txt', 'Hello RemoteStorage!');

// List directory
const files = await fs.promises.readdir('/remote/docs/');
```

### With zen-fs-sync

```typescript
import { SyncPair, SyncDirection } from 'zen-fs-sync';
import { createRemoteStorageFileSystem } from 'zen-fs-remotestoragejs';

const remoteFS = createRemoteStorageFileSystem({
  href: 'https://storage.5apps.com/',
  token: 'your-token',
  basePath: '/public/my-app/',
});

// Sync local IndexedDB with RemoteStorage
const pair = new SyncPair(localFS, remoteFS, {
  direction: SyncDirection.BiDirectional,
  pollIntervalMs: 300000, // 5 minutes
});

// shouldSync() is implemented — remote polls are cheap (1 HEAD request)
pair.watch();
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `href` | `string` | **required** | Base URL of the RemoteStorage server |
| `token` | `string` | **required** | Bearer token for authentication |
| `basePath` | `string` | `undefined` | Base path prefix for all file operations (e.g. `'/public/'`, `'/username/app_data/'`) |
| `headers` | `Record<string, string>` | `undefined` | Extra HTTP headers to include in every request |
| `timeout` | `number` | `30000` | Request timeout in milliseconds |
| `preciseMtime` | `boolean` | `true` | Enable millisecond-precision mtime via `.mtime` sidecar files |
| `persistCache` | `boolean` | `true` | Persist directory listing cache to localStorage (browser) or file (Node.js) |
| `cacheFile` | `string` | `.zen-fs-remotestorage-cache.json` | Path for persisted cache file (Node.js only) |
| `syncRootPath` | `string` | `'/'` or `'app_data/'` | Path used as the sync baseline for `shouldSync()` |

## How Caching Works

The backend uses a multi-layer caching strategy to minimize network requests:

1. **Directory listing cache** — `readdir()` results are cached with ETags. On subsequent calls, the ETag is sent via `If-None-Match`; if the server returns 304, the cached listing is reused. This means `stat()` calls for files in a cached directory need no extra network requests — metadata comes directly from the listing entry.

2. **Existence cache** — `exists()` results are cached with separate TTLs for positive (5 min) and negative (1 min) results. This avoids repeated HEAD requests for the same path.

3. **Persistent cache** — The directory listing cache is saved to localStorage (browser) or a JSON file (Node.js), so a warm page load needs zero network requests for most `stat()` and `readdir()` calls.

## Sync Optimization

The backend implements the `SyncableFS` interface with several optimizations:

- **`shouldSync()`** — sends a single HEAD request to the root folder and compares ETags. If unchanged, returns `false` and no full sync is needed.
- **`createSnapshot()`** — builds a full file tree with ETags by walking directories. Uses subtree pruning: if a folder's ETag hasn't changed since the last snapshot, its entire subtree is skipped.
- **`getRevision()`** — returns a file's ETag from the cached directory listing when available, falling back to HEAD only when necessary.
- **`writeFileWithMtime()`** — preserves precise mtime via sidecar files, so sync can compare timestamps accurately.

## Exports

| Export | Description |
|--------|-------------|
| `RemoteStorageFileSystem` | Main class (also the default export) |
| `createRemoteStorageFileSystem(config)` | Factory function |
| `createUniversalSyncFileSystem`, `adaptFileSystem` | Sync adapter helpers |
| `RemoteStorageError` | Base error class |
| `FileNotFoundError` | Thrown on 404 for files |
| `DirectoryNotFoundError` | Thrown on 404 for directories |
| `FileExistsError` | Thrown on 409 conflict |
| `AuthenticationError` | Thrown on 401 |
| `PermissionDeniedError` | Thrown on 403 |
| Path utilities | `normalizePath`, `joinPath`, `getBasename`, `getParentPath`, `isValidPath`, and more |

## Error Handling

All errors thrown by the backend are instances of `RemoteStorageError` or its subclasses:

```typescript
import { RemoteStorageFileSystem, FileNotFoundError } from 'zen-fs-remotestoragejs';

try {
  await fs.readFile('/nonexistent.txt');
} catch (error) {
  if (error instanceof FileNotFoundError) {
    console.log('File does not exist');
  } else if (error instanceof AuthenticationError) {
    console.log('Token expired or invalid');
  }
}
```

## License

MIT
