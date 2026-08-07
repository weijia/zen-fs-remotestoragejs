/**
 * Persistence layer for RemoteStorageFileSystem caches.
 *
 * Environment-adaptive, zero-dependency storage abstraction:
 *  - Browser:        `localStorage` (synchronous, simple)
 *  - Node.js:        JSON file via `node:fs` (path configurable, default
 *                    `<cwd>/.zen-fs-remotestorage-cache.json`)
 *  - Otherwise:      in-memory Map (degrades gracefully, no persistence)
 *
 * Data is stored namespaced by a key (typically `baseUrl + basePath`) so that
 * multiple RemoteStorage accounts/devices do not collide.
 */

export interface CacheStorage {
  /** Load the full persisted map (namespace → JSON-serializable value). */
  load(): Promise<Record<string, unknown>>;
  /** Persist the full map. Should be cheap / debounced by the caller. */
  save(data: Record<string, unknown>): Promise<void>;
}

function isBrowserLike(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as any).localStorage !== 'undefined' &&
    typeof (globalThis as any).window !== 'undefined'
  );
}

/**
 * localStorage-backed storage. Synchronous API wrapped in promises to keep a
 * uniform async interface with the file-based backend.
 */
class LocalStorageCache implements CacheStorage {
  constructor(private readonly key: string) {}

  async load(): Promise<Record<string, unknown>> {
    try {
      const raw = (globalThis as any).localStorage.getItem(this.key);
      if (!raw) return {};
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async save(data: Record<string, unknown>): Promise<void> {
    try {
      (globalThis as any).localStorage.setItem(this.key, JSON.stringify(data));
    } catch {
      // Quota or serialization errors are non-fatal for a cache.
    }
  }
}

/**
 * node:fs JSON-file-backed storage.
 */
class FileCache implements CacheStorage {
  constructor(private readonly filePath: string) {}

  private async readFile(): Promise<string | null> {
    try {
      const { readFile } = await import('node:fs/promises');
      return await readFile(this.filePath, 'utf-8');
    } catch (err: any) {
      if (err && err.code === 'ENOENT') return null;
      return null;
    }
  }

  async load(): Promise<Record<string, unknown>> {
    const raw = await this.readFile();
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async save(data: Record<string, unknown>): Promise<void> {
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(data), 'utf-8');
    } catch {
      // Non-fatal for a cache.
    }
  }
}

/**
 * Fallback in-memory storage (no persistence across restarts).
 */
class MemoryCache implements CacheStorage {
  private map: Record<string, unknown> = {};
  async load(): Promise<Record<string, unknown>> {
    return this.map;
  }
  async save(data: Record<string, unknown>): Promise<void> {
    this.map = data;
  }
}

/**
 * Create a CacheStorage for the given namespace key.
 *
 * @param storageKey  Unique key under which the whole cache blob is stored.
 * @param fileOption  Optional explicit file path (Node only). When omitted,
 *                    Node falls back to `<cwd>/.zen-fs-remotestorage-cache.json`.
 */
export function createCacheStorage(
  storageKey: string,
  fileOption?: string,
): CacheStorage {
  if (isBrowserLike()) {
    return new LocalStorageCache(storageKey);
  }
  try {
    // Detect Node without hard-depending on node: modules at import time.
    const filePath =
      fileOption ||
      (typeof process !== 'undefined' && process.cwd
        ? `${process.cwd()}/.zen-fs-remotestorage-cache.json`
        : '.zen-fs-remotestorage-cache.json');
    return new FileCache(filePath);
  } catch {
    return new MemoryCache();
  }
}
