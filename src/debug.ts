/**
 * Centralized debug logging for RemoteStorageFileSystem.
 *
 * Powered by @richard432/localstorage-logger — each sub-function area
 * has an independent localStorage key `debug:rs:<area>` that can be
 * toggled at runtime:
 *
 *   localStorage.setItem('debug:rs:stat', '0')   // silence stat logs
 *   localStorage.setItem('debug:rs:cache', '1')  // enable cache logs
 *
 * All keys default to '1' (enabled) on first access.
 */

import {
  createLogger as createLoggerBase,
  type Logger,
} from '@richard432/localstorage-logger';

// ---------------------------------------------------------------------------
// Sub-function area loggers
// ---------------------------------------------------------------------------

/** Each area maps to a localStorage key `debug:rs:<area>`. */
export const loggers = {
  /** HTTP-level request/response logging (buildUrl, makeRequest) */
  http: createLoggerBase('rs:http'),
  /** File existence checks + existence cache */
  exists: createLoggerBase('rs:exists'),
  /** File read operations (readFile, readFileMeta, read) */
  read: createLoggerBase('rs:read'),
  /** File write operations (writeFile, writeFileWithMtime, write, createFile) */
  write: createLoggerBase('rs:write'),
  /** stat() / metadata probing (HEAD requests, dir probes) */
  stat: createLoggerBase('rs:stat'),
  /** Directory listing + cache + patch (ensureDirListing, patchDirListingEntry, readdir, mkdir, rmdir) */
  dir: createLoggerBase('rs:dir'),
  /** File/directory deletion (unlink, rmdir) */
  delete: createLoggerBase('rs:delete'),
  /** Cache persistence (load/save dirListingCache to IndexedDB) */
  cache: createLoggerBase('rs:cache'),
  /** Sync status (shouldSync, buildSnapshot, sync, disconnect) */
  sync: createLoggerBase('rs:sync'),
  /** mtime sidecar operations (writeMtimeSidecar, deleteMtimeSidecar, getRevision, touch, link) */
  mtime: createLoggerBase('rs:mtime'),
  /** Rename operations */
  rename: createLoggerBase('rs:rename'),
  /** Metadata operations not covered by other areas */
  meta: createLoggerBase('rs:meta'),
} as const;

export type LoggerArea = keyof typeof loggers;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(data: unknown, max = 200): string {
  let s: string;
  try {
    s = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    s = String(data);
  }
  if (s === undefined) s = 'undefined';
  if (s.length > max) return s.slice(0, max) + '...';
  return s;
}

// ---------------------------------------------------------------------------
// Backward-compatible createLogger(backendName)
// ---------------------------------------------------------------------------

/**
 * Maps method names to logger areas for backward-compatible `this.logger` calls.
 * Methods not listed here default to `meta`.
 */
const methodToArea: Record<string, LoggerArea> = {
  buildUrl: 'http',
  makeRequest: 'http',
  exists: 'exists',
  readFile: 'read',
  readFileMeta: 'read',
  read: 'read',
  writeFile: 'write',
  writeFileWithMtime: 'write',
  write: 'write',
  createFile: 'write',
  stat: 'stat',
  readdir: 'dir',
  mkdir: 'dir',
  rmdir: 'dir',
  ensureDirListing: 'dir',
  patchDirListingEntry: 'dir',
  unlink: 'delete',
  rename: 'rename',
  cache: 'cache',
  shouldSync: 'sync',
  buildSnapshot: 'sync',
  sync: 'sync',
  disconnect: 'sync',
  writeMtimeSidecar: 'mtime',
  deleteMtimeSidecar: 'mtime',
  getRevision: 'mtime',
  touch: 'mtime',
  link: 'mtime',
};

/**
 * Create a backward-compatible logger bound to a specific backend name.
 * Calls are routed to the appropriate sub-function area logger based on
 * the method name.
 */
export function createLogger(backendName: string) {
  const log = (method: string, path: string, detail?: Record<string, unknown>) => {
    const area = methodToArea[method] ?? 'meta';
    const logger: Logger = loggers[area];
    const parts = [`[RS:${backendName}] ${method} path=${path}`];
    if (detail) {
      for (const [k, v] of Object.entries(detail)) {
        parts.push(`${k}=${truncate(v)}`);
      }
    }
    logger.log(parts.join(' '));
  };

  const logResult = (method: string, path: string, result: unknown, ok = true) => {
    const area = methodToArea[method] ?? 'meta';
    const logger: Logger = loggers[area];
    const status = ok ? 'OK' : 'ERR';
    logger.log(`[RS:${backendName}] ${method} path=${path} → ${status} ${truncate(result)}`);
  };

  return { log, logResult };
}
