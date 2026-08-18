/**
 * Configuration options for RemoteStorage filesystem
 */
export interface RemoteStorageConfig {
  /**
   * The base URL of the RemoteStorage server (storage endpoint)
   */
  href: string;
  
  /**
   * Bearer token for authentication
   */
  token: string;
  
  /**
   * Base path for files (usually starts with '/public/' or '/username/')
   */
  basePath?: string;
  
  /**
   * Custom headers to include in requests
   */
  headers?: Record<string, string>;
  
  /**
   * Request timeout in milliseconds
   */
  timeout?: number;

  /**
   * Enable precise mtime via .mtime sidecar files. Default: true
   *
   * When enabled, writeFile() creates a .mtime sidecar file on RemoteStorage,
   * stat() reads it to return millisecond-precision mtime, and touch() works.
   * Sidecar files are filtered from readdir() results — they are invisible
   * to upper layers.
   */
  preciseMtime?: boolean;

  /**
   * Enable persistence of the directory-listing cache to local storage.
   * Default: true. When enabled, the cache (with ETag-based invalidation) is
   * restored on startup and written back on changes, so most stat()/readdir()
   * calls need zero network requests after a warm start.
   *
   * - Browser: uses `localStorage`.
   * - Node.js: uses a JSON file (see `cacheFile`).
   */
  persistCache?: boolean;

  /**
   * Explicit file path for the persisted cache when running under Node.js.
   * Defaults to `<cwd>/.zen-fs-remotestorage-cache.json`. Ignored in browsers.
   */
  cacheFile?: string;

  /**
   * Path used as the "sync baseline" when checking whether anything changed
   * remotely (see shouldSync()).
   *
   * Defaults to '/' when basePath is set (root maps to basePath via buildUrl),
   * or 'app_data/' when basePath is empty (to avoid 401 on the account root).
   *
   * RemoteStorage servers scope a Bearer token to the modules declared via
   * claimAccess() (e.g. `onenav`, `app_data`). The account root (e.g.
   * `/username/`) is NOT covered by any module scope, so a HEAD/GET on the
   * root returns 401. When basePath is empty, the default 'app_data/' keeps
   * the sync-check request inside the token's scope.
   */
  syncRootPath?: string;
}

/**
 * File/directory statistics interface
 */
export interface RemoteStorageStat {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  lastModified: Date;
  contentType?: string;
  ETag?: string;
}

/**
 * Directory entry interface
 */
export interface RemoteStorageEntry {
  name: string;
  isDirectory: boolean;
  size?: number;
  lastModified?: Date;
  contentType?: string;
  ETag?: string;
}

/**
 * Error types for RemoteStorage operations
 */
export class RemoteStorageError extends Error {
  constructor(
    message: string,
    public code?: string,
    public status?: number
  ) {
    super(message);
    this.name = 'RemoteStorageError';
  }
}

/**
 * File not found error
 */
export class FileNotFoundError extends RemoteStorageError {
  constructor(path: string) {
    super(`File not found: ${path}`, 'ENOENT', 404);
    this.name = 'FileNotFoundError';
  }
}

/**
 * Directory not found error
 */
export class DirectoryNotFoundError extends RemoteStorageError {
  constructor(path: string) {
    super(`Directory not found: ${path}`, 'ENOENT', 404);
    this.name = 'DirectoryNotFoundError';
  }
}

/**
 * File already exists error
 */
export class FileExistsError extends RemoteStorageError {
  constructor(path: string) {
    super(`File already exists: ${path}`, 'EEXIST', 409);
    this.name = 'FileExistsError';
  }
}

/**
 * Authentication error
 */
export class AuthenticationError extends RemoteStorageError {
  constructor(message: string = 'Authentication failed') {
    super(message, 'EAUTH', 401);
    this.name = 'AuthenticationError';
  }
}

/**
 * Permission denied error
 */
export class PermissionDeniedError extends RemoteStorageError {
  constructor(path: string) {
    super(`Permission denied: ${path}`, 'EACCES', 403);
    this.name = 'PermissionDeniedError';
  }
}
