/**
 * Adapter that exposes a `RemoteStorageFileSystem` (or any compatible zen-fs
 * filesystem, e.g. a `zen-fs-cache` `CachedFileSystem` wrapper) as the
 * `IFileSystem` interface expected by `universal-sync-v2`'s `SyncEngine`.
 *
 * For transparent HTTP revalidation + persistence, wrap the remote filesystem
 * with `zen-fs-cache` and adapt the result:
 *
 * ```ts
 * import { RemoteStorageFileSystem, adaptFileSystem } from 'zen-fs-remotestoragejs';
 * import { CachedFileSystem, IdbCacheStore } from 'zen-fs-cache';
 *
 * const cached = new CachedFileSystem(
 *   new RemoteStorageFileSystem({ href, token }),
 *   new IdbCacheStore('onenav:'),
 * );
 * const engine = new SyncEngine(db, adaptFileSystem(cached), { basePath: '/onenav' });
 * ```
 */

import { RemoteStorageFileSystem } from './RemoteStorageFileSystem.js';
import type { RemoteStorageConfig } from './types.js';
import { uint8ArrayToString } from './utils.js';

/** Structural subset of a zen-fs filesystem used by the adapter. */
export interface ZenFsLike {
  readFile(path: string, ...args: any[]): Promise<Uint8Array>;
  writeFile(
    path: string,
    data: string | Uint8Array | ArrayBuffer,
    options?: any,
  ): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: any): Promise<any>;
  stat(path: string, ...args: any[]): Promise<any>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/**
 * Structural mirror of `universal-sync-v2`'s `IFileSystem`. We intentionally
 * re-declare it here (instead of importing the type) so this package has no
 * hard dependency on `universal-sync-v2`.
 */
export interface UniversalSyncFileSystem {
  readFile(path: string, encoding: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; mtime: Date }>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/**
 * Adapt any compatible zen-fs filesystem to the universal-sync-v2 string-based
 * `IFileSystem`. This is the composition point where `zen-fs-cache` plugs in.
 */
export function adaptFileSystem(fs: ZenFsLike): UniversalSyncFileSystem {
  return {
    async readFile(path: string, encoding: string): Promise<string> {
      const bytes = await fs.readFile(path);
      // universal-sync-v2 always passes 'utf8'; decode accordingly.
      void encoding;
      return uint8ArrayToString(bytes);
    },

    async writeFile(path: string, data: string): Promise<void> {
      await fs.writeFile(path, data);
    },

    async readdir(path: string): Promise<string[]> {
      return fs.readdir(path);
    },

    async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
      await fs.mkdir(path, { mode: 0o040755 });
    },

    async stat(path: string) {
      const st = await fs.stat(path);
      const isDir = (st.mode & 0o040000) === 0o040000;
      return {
        isFile: () => !isDir,
        isDirectory: () => isDir,
        mtime: new Date(st.mtimeMs),
      };
    },

    async unlink(path: string): Promise<void> {
      await fs.unlink(path);
    },

    async rename(oldPath: string, newPath: string): Promise<void> {
      const content = await fs.readFile(oldPath);
      await fs.writeFile(newPath, uint8ArrayToString(content));
      await fs.unlink(oldPath);
    },

    async exists(path: string): Promise<boolean> {
      return fs.exists(path);
    },
  };
}

/**
 * Convenience helper: build a `RemoteStorageFileSystem` from config and adapt
 * it. For caching, prefer constructing `CachedFileSystem` yourself and passing
 * it to {@link adaptFileSystem}.
 */
export function createUniversalSyncFileSystem(config: RemoteStorageConfig): UniversalSyncFileSystem {
  return adaptFileSystem(new RemoteStorageFileSystem(config));
}
