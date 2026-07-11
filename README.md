# zen-fs-remotestoragejs

A [zen-fs](https://github.com/weijia/zen-fs) backend for [RemoteStorage.js](https://remotestorage.io/)
— a distributed file system interface backed by RemoteStorage-compatible storage
(including various cloud providers).

## Install

```bash
npm install zen-fs-remotestoragejs
```

> Depends on `@zenfs/core` (>=2.3.3).

## Usage

```ts
import {
  RemoteStorageFileSystem,
  createRemoteStorageFileSystem,
} from 'zen-fs-remotestoragejs';

// Recommended factory:
const fs = createRemoteStorageFileSystem({ href, token });

// Or directly:
const fs2 = new RemoteStorageFileSystem({ href, token });
```

## Exports

- `RemoteStorageFileSystem` (also the default export)
- `createRemoteStorageFileSystem(config)`
- `createUniversalSyncFileSystem`, `adaptFileSystem`
- Error types: `RemoteStorageError`, `FileNotFoundError`, `DirectoryNotFoundError`,
  `FileExistsError`, `AuthenticationError`, `PermissionDeniedError`
- Path utilities: `normalizePath`, `joinPath`, `getBasename`, `getParentPath`, `isValidPath`, ...

## License

MIT
