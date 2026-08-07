import { FileSystem, Stats, InodeLike } from '@zenfs/core';
import { CreationOptions } from '@zenfs/core/internal/filesystem.js';
import {
  RemoteStorageConfig,
  RemoteStorageStat,
  RemoteStorageEntry,
  RemoteStorageError,
  FileNotFoundError,
  DirectoryNotFoundError,
  FileExistsError,
  AuthenticationError,
  PermissionDeniedError,
} from './types.js';
import {
  normalizePath,
  getParentPath,
  getBasename,
  isDirectoryPath,
  ensureDirectoryPath,
  toUint8Array,
  uint8ArrayToString,
  isBinaryContentType,
  getCurrentTimestamp,
  isValidPath,
  joinPath,
  mtimePathFor,
  isMtimeSidecar,
} from './utils.js';
import { rsLog, rsLogResult } from './debug.js';
import { createCacheStorage, CacheStorage } from './persistence.js';
import { IdbKVStore } from 'zen-fs-cache';

/**
 * A single cached child entry within a directory listing.
 */
interface DirEntry {
  name: string;
  isDir: boolean;
  etag?: string | null;
  size?: number;
  lastModified?: string;
}

/**
 * RemoteStorage filesystem implementation for zen-fs using direct HTTP requests
 */
export class RemoteStorageFileSystem extends FileSystem {
  /**
   * 校验并标准化路径，抛出异常或返回标准化后的路径
   */
  private validateAndNormalizePath(path: string, ensureDir: boolean = false): string {
    if (!isValidPath(path)) {
      throw new RemoteStorageError('Invalid path format');
    }
    let p = normalizePath(path);
    if (ensureDir) {
      p = ensureDirectoryPath(p);
    }
    return p;
  }

  /**
   * 获取目录下的所有条目，返回标准化后的绝对路径数组
   */
  private async getDirectoryEntries(path: string): Promise<string[]> {
    const entries = await this.readdir(path);
    return entries.map(entry => joinPath(path, entry));
  }
  private baseUrl: string;
  private headers: Headers;
  private timeout: number;
  readonly backendName: string;

  /**
   * Existence cache to avoid repeated HEAD/GET requests for the same path.
   * - `true`  = confirmed to exist (valid until invalidated by mutations)
   * - `false` = confirmed missing (with TTL to allow re-checking after writes)
   * - `undefined` = unknown, needs network check
   */
  private existenceCache = new Map<string, { exists: boolean; ts: number }>();
  private static readonly NEGATIVE_CACHE_TTL = 15_000; // 15s for negative results

  /**
   * Directory listing cache — caches readdir() results (with per-entry
   * metadata: isDir, etag, size, lastModified) so that stat() can return
   * without a HEAD request, and multiple stat() calls in a directory share
   * one network request.
   *
   * Invalidation is ETag-based (precise): a directory entry is refreshed only
   * when its ETag changes. A long TTL acts as a fallback for servers that do
   * not return directory ETags.
   */
  private dirListingCache = new Map<
    string,
    { etag: string | null; ts: number; entries: Map<string, DirEntry> }
  >();
  private static readonly DIR_LISTING_TTL = 300_000; // 5 minutes (fallback)

  /** One cached directory entry (a child of some directory). */
  private static readonly EMPTY_DIR: DirEntry = {
    name: '',
    isDir: true,
    etag: null,
    size: 0,
    lastModified: undefined,
  };

  /**
   * Whether HEAD is supported by this server.
   * - `null`  = unknown, will probe on first stat()
   * - `false` = server returned 405 or similar, skip HEAD in future calls
   * - `true`  = HEAD works, use it as the fast path
   *
   * This avoids wasting a request on servers that don't support HEAD.
   */
  private headSupported: boolean | null = null;

  // --- Precise mtime ---
  /** Whether to use .mtime sidecar files for precise mtime. Default: true */
  private readonly usePreciseMtime: boolean;
  /** In-memory cache of sidecar mtime values to avoid repeated GETs */
  private mtimeCache = new Map<string, number>();

  // --- Snapshot (ETag baseline for shouldSync) ---
  /** In-memory map of path → ETag, used by shouldSync() to detect remote changes */
  private snapshot: Map<string, string> | null = null;
  /** Root folder's ETag, used as a quick "anything changed?" check */
  private rootEtag: string | null = null;
  /** Whether we've already attempted to restore snapshot from IndexedDB */
  private snapshotLoaded: boolean = false;

  // --- IndexedDB persistence for snapshot and mtimeCache ---
  /** Persists the ETag snapshot and rootEtag across page reloads. */
  private readonly snapshotStore: IdbKVStore;
  /** Persists mtimeCache (path → mtime ms) across page reloads. */
  private readonly mtimeStore: IdbKVStore;

  // --- Persistent directory cache ---
  /** Whether the directory-listing cache is persisted to local storage. */
  private readonly persistCache: boolean;
  /** Storage backend (localStorage / file / memory). */
  private storage: CacheStorage | null = null;
  /** Namespace key for this connection (baseUrl + basePath). */
  private readonly cacheNamespace: string;
  /** Memoized promise resolving once the cache has been loaded from storage. */
  private loadPromise: Promise<void> | null = null;
  /** Debounced save handle. */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: RemoteStorageConfig) {
    super(0 as any, 0 as any); // FileSystem constructor - using type assertion for now
    
    // Set backend name for zen-fs-sync logging
    this.backendName = `RemoteStorage@${config.href.replace(/^https?:\/\//, '')}`;

    // Normalize base URL
    this.baseUrl = config.href.endsWith('/') ? config.href.slice(0, -1) : config.href;
    
    // Normalize basePath: ensure leading '/' and trailing '/'
    // RemoteStorage spec requires directory URLs to end with '/'
    let bp = config.basePath || '';
    if (bp && !bp.startsWith('/')) bp = '/' + bp;
    if (bp && !bp.endsWith('/')) bp = bp + '/';
    this.config = { ...config, basePath: bp };
    
    // Set up headers
    this.headers = new Headers({
      'Authorization': `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      ...config.headers,
    });
    
    this.timeout = config.timeout || 30000;

    // Precise mtime is enabled by default
    this.usePreciseMtime = config.preciseMtime !== false;

    // Persistent directory cache setup
    this.persistCache = config.persistCache !== false;
    this.cacheNamespace = `${this.baseUrl}${this.config.basePath}`;
    if (this.persistCache) {
      this.storage = createCacheStorage(
        'zen-fs-remotestorage-cache',
        config.cacheFile,
      );
    }

    // IndexedDB persistence for snapshot and mtimeCache
    const idbDbBase = `zen-fs-remotestorage:${this.cacheNamespace}`;
    this.snapshotStore = new IdbKVStore(`${idbDbBase}:snapshot`, 'cache');
    this.mtimeStore = new IdbKVStore(`${idbDbBase}:mtime`, 'cache');
  }

  /**
   * Build full URL for a path
   */
  private buildUrl(path: string): string {
    const basePath = this.config.basePath || '';
    const normalizedPath = normalizePath(path);
    const isDir = path === '/' || path.endsWith('/');
    const suffix = normalizedPath
      ? '/' + normalizedPath + (isDir ? '/' : '')
      : (isDir ? '/' : '');
    const fullPath = basePath.endsWith('/') && suffix.startsWith('/')
      ? basePath + suffix.slice(1)
      : basePath + suffix;
    const url = this.baseUrl + fullPath;
    rsLog('buildUrl', path, { isDir, url });
    return url;
  }

  /**
   * Make HTTP request with timeout
   */
  private async makeRequest(url: string, options: RequestInit = {}): Promise<Response> {
    const method = options.method || 'GET';
    rsLog('makeRequest', url, { method, attempt: 'start' });
    const maxRetries = 3;
    let lastError: any = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      try {
        const response = await fetch(url, {
          ...options,
          credentials: 'omit',
          headers: {
            'Authorization': `Bearer ${this.config.token}`,
            'Content-Type': 'application/json',
            ...this.config.headers,
            ...options.headers,
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        rsLogResult('makeRequest', url, `${method} status=${response.status}`);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error;
        rsLogResult('makeRequest', url, `${method} attempt=${attempt + 1} error=${error instanceof Error ? error.message : String(error)}`, false);
        if (error instanceof Error && (error.name === 'AbortError' || error.name === 'FetchError' || error.message?.includes('network'))) {
          if (attempt < maxRetries - 1) {
            await new Promise(res => setTimeout(res, 200 * (attempt + 1)));
            continue;
          }
        }
        if (error instanceof Error && error.name === 'AbortError') {
          throw new RemoteStorageError('Request timeout');
        }
        throw error;
      }
    }
    throw lastError || new RemoteStorageError('Unknown HTTP request error');
  }

  /**
   * Handle HTTP response errors
   */
  private handleHttpError(response: Response, path: string, operation: string): void {
    if (response.status === 404) {
      throw new FileNotFoundError(path);
    } else if (response.status === 401) {
      throw new AuthenticationError('Invalid or expired token');
    } else if (response.status === 403) {
      throw new PermissionDeniedError(path);
    } else if (response.status === 409) {
      throw new FileExistsError(path);
    } else if (!response.ok) {
      throw new RemoteStorageError(
        `${operation} failed for ${path}: ${response.status} ${response.statusText}`
      );
    }
  }

  /**
   * Check if path is a directory by trying to list it
   */
  private async isDirectory(path: string): Promise<boolean> {
    try {
      // Ensure trailing slash so buildUrl generates a directory URL
      const dirPath = path.endsWith('/') ? path : path + '/';
      const dirUrl = this.buildUrl(dirPath);
      const response = await this.makeRequest(dirUrl, { method: 'GET' });

      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        return contentType.includes('application/ld+json') || contentType.includes('text/html');
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check if file/directory exists
   */
  async exists(path: string): Promise<boolean> {
    rsLog('exists', path);

    // Check cache first
    const normalized = normalizePath(path);
    const cached = this.existenceCache.get(normalized);
    if (cached) {
      if (cached.exists) {
        rsLogResult('exists', path, true, true);
        return true;
      }
      // Negative result: respect TTL
      if (Date.now() - cached.ts < RemoteStorageFileSystem.NEGATIVE_CACHE_TTL) {
        rsLogResult('exists', path, false, true);
        return false;
      }
    }

    try {
      await this.stat(path);
      this.existenceCache.set(normalized, { exists: true, ts: Date.now() });
      rsLogResult('exists', path, true);
      return true;
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        this.existenceCache.set(normalized, { exists: false, ts: Date.now() });
        rsLogResult('exists', path, false);
        return false;
      }
      rsLogResult('exists', path, error, false);
      throw error;
    }
  }

  /**
   * Read file contents
   */
  async readFile(path: string): Promise<Uint8Array> {
    rsLog('readFile', path);
    path = this.validateAndNormalizePath(path);
    const url = this.buildUrl(path);
    try {
      const response = await this.makeRequest(url, { method: 'GET' });
      if (!response.ok) {
        this.handleHttpError(response, path, 'readFile');
      }
      const arrayBuffer = await response.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      rsLogResult('readFile', path, `size=${data.byteLength}`);
      return data;
    } catch (error) {
      rsLogResult('readFile', path, error, false);
      if (error instanceof FileNotFoundError || error instanceof RemoteStorageError) {
        throw error;
      }
      throw new RemoteStorageError(
        `Failed to read file ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Write file contents
   */
  async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: { flag?: string; mtime?: number }): Promise<void> {
    const size = typeof data === 'string' ? data.length : (data as Uint8Array).byteLength;
    rsLog('writeFile', path, { flag: options?.flag, size });
    path = this.validateAndNormalizePath(path);
    const flag = options?.flag;
    // Check if file exists for exclusive flags
    if (flag === 'x' || flag === 'wx') {
      const exists = await this.exists(path);
      if (exists) {
        rsLogResult('writeFile', path, 'FileExistsError', false);
        throw new FileExistsError(path);
      }
    }
    const url = this.buildUrl(path);
    try {
      // 直接写文件，不自动创建父目录
      let body: BodyInit;
      let contentType: string;
      if (typeof data === 'string') {
        body = data;
        contentType = 'text/plain; charset=utf-8';
      } else if (data instanceof Uint8Array) {
        body = data as unknown as BodyInit;
        contentType = 'application/octet-stream';
      } else if (data instanceof ArrayBuffer) {
        body = data;
        contentType = 'application/octet-stream';
      } else {
        throw new RemoteStorageError('Unsupported data type for writing');
      }
      const headers = new Headers(this.headers);
      headers.set('Content-Type', contentType);
      const response = await this.makeRequest(url, {
        method: 'PUT',
        body,
        headers,
      });
      if (!response.ok) {
        this.handleHttpError(response, path, 'writeFile');
      }
      rsLogResult('writeFile', path, `status=${response.status}`);
      this.invalidateExistenceCache(path);

      // Write .mtime sidecar if precise mtime is enabled
      if (this.usePreciseMtime) {
        const mtime = options?.mtime ?? Date.now();
        await this.writeMtimeSidecar(path, mtime);
      }

      // Precisely patch this file's entry in the parent directory's cached
      // listing (ETag-based fine-grained invalidation — siblings stay valid).
      const newEtag = response.headers.get('ETag') ?? undefined;
      const parentPath = getParentPath(path);
      const parentDir = parentPath ? `/${parentPath}/` : '/';
      await this.patchDirListingEntry(parentDir, getBasename(path), {
        name: getBasename(path),
        isDir: false,
        etag: newEtag,
        size,
        lastModified: response.headers.get('Last-Modified') ?? undefined,
      });

      // Update snapshot with new ETag from PUT response
      this.updateSnapshotForPath(path, newEtag ?? null);
    } catch (error) {
      rsLogResult('writeFile', path, error, false);
      if (error instanceof FileExistsError || error instanceof RemoteStorageError) {
        throw error;
      }
      throw new RemoteStorageError(
        `Failed to write file ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Write file with precise mtime — implements SyncableFS.writeFileWithMtime.
   *
   * Delegates to writeFile() with { mtime } option. When preciseMtime is
   * enabled, a .mtime sidecar is written preserving the exact mtime.
   */
  async writeFileWithMtime(path: string, data: string | Uint8Array | ArrayBuffer, mtime: number): Promise<void> {
    rsLog('writeFileWithMtime', path, { mtime });
    await this.writeFile(path, data, { mtime });
  }

  /**
   * Delete file.
   *
   * Existence check before deletion is handled centrally by
   * zen-fs-config's processTombstones() via safeExists(), so this method
   * simply sends the DELETE request. Individual backends do not need to
   * duplicate the check.
   */
  async unlink(path: string): Promise<void> {
    rsLog('unlink', path);
    path = this.validateAndNormalizePath(path);

    try {
      const url = this.buildUrl(path);
      const response = await this.makeRequest(url, { method: 'DELETE' });
      if (!response.ok) {
        this.handleHttpError(response, path, 'unlink');
      }
      rsLogResult('unlink', path, `status=${response.status}`);
      this.removeFromExistenceCache(path);

      // Precisely remove this file's entry from the parent directory's cached
      // listing (siblings stay valid).
      const parentPath = getParentPath(path);
      const parentDir = parentPath ? `/${parentPath}/` : '/';
      await this.patchDirListingEntry(parentDir, getBasename(path), null);

      // Delete .mtime sidecar if precise mtime is enabled
      if (this.usePreciseMtime) {
        await this.deleteMtimeSidecar(path);
      }

      // Update snapshot — remove the deleted path
      this.updateSnapshotForPath(path, null);
    } catch (error) {
      rsLogResult('unlink', path, error, false);
      if (error instanceof FileNotFoundError || error instanceof RemoteStorageError) {
        throw error;
      }
      throw new RemoteStorageError(
        `Failed to unlink ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Read directory contents
   */
  async readdir(path: string): Promise<string[]> {
    rsLog('readdir', path);
    // Ensure cache is restored from storage before serving (cheap, memoized).
    await this.ensureCacheLoaded();
    path = this.validateAndNormalizePath(path, true);
    const dirUrl = this.buildUrl(path);
    try {
      const response = await this.makeRequest(dirUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/ld+json' },
      });
      if (!response.ok) {
        if (response.status === 404) {
          rsLogResult('readdir', path, 'DirectoryNotFoundError', false);
          throw new DirectoryNotFoundError(path);
        }
        this.handleHttpError(response, path, 'readdir');
      }
      const contentType = response.headers.get('content-type') || '';
      let entries: DirEntry[];
      if (contentType.includes('application/ld+json')) {
        const listing = await response.json();
        entries = [];
        if (listing['@graph']) {
          for (const item of listing['@graph']) {
            if (item['@id'] && item['@id'] !== './') {
              const rawName = item['@id'];
              const isDir = rawName.endsWith('/');
              const name = rawName.replace(/\/$/, '');
              if (name) {
                entries.push({
                  name,
                  isDir,
                  etag: item['ETag'] ?? item['etag'],
                  size: item['Content-Length'] != null
                    ? Number(item['Content-Length'])
                    : undefined,
                  lastModified: item['Last-Modified'] ?? item['last-modified'],
                });
              }
            }
          }
        } else if (listing['items'] && typeof listing['items'] === 'object') {
          for (const entryKey of Object.keys(listing['items'])) {
            if (entryKey && entryKey !== './') {
              const isDir = entryKey.endsWith('/');
              const name = entryKey.replace(/\/$/, '');
              const item = listing['items'][entryKey];
              entries.push({
                name,
                isDir,
                etag: item?.ETag ?? item?.etag,
                size: item?.['Content-Length'] != null
                  ? Number(item['Content-Length'])
                  : undefined,
                lastModified: item?.['Last-Modified'] ?? item?.['last-modified'],
              });
            }
          }
        }
      } else {
        const html = await response.text();
        const names = this.parseHtmlDirectoryListing(html);
        entries = names.map(name => ({ name, isDir: name.endsWith('/'), etag: undefined }));
      }
      // Filter out .mtime sidecar files — they are internal to RemoteStorageFileSystem
      const filtered = entries.filter(e => !isMtimeSidecar(e.name));
      const names = filtered.map(e => e.name);
      rsLogResult('readdir', path, `count=${names.length} [${names.join(', ')}]`);
      this.existenceCache.set(normalizePath(path), { exists: true, ts: Date.now() });
      // Cache the directory listing (with metadata) for stat() existence/metadata
      this.cacheDirListing(path, filtered, response.headers.get('ETag'));
      return names;
    } catch (error) {
      rsLogResult('readdir', path, error, false);
      if (error instanceof DirectoryNotFoundError || error instanceof RemoteStorageError) {
        throw error;
      }
      throw new RemoteStorageError(
        `Failed to read directory ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Parse HTML directory listing (fallback)
   */
  private parseHtmlDirectoryListing(html: string): string[] {
    const items: string[] = [];
    const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let match;
    
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const name = match[2];
      
      // Skip parent directory and current directory links
      if (href !== '../' && href !== './' && name !== '..' && name !== '.') {
        const cleanName = href.endsWith('/') ? href.slice(0, -1) : href;
        if (cleanName) {
          items.push(cleanName);
        }
      }
    }
    
    return items;
  }

  /**
   * Create directory
   */
  async mkdir(path: string, options?: CreationOptions): Promise<InodeLike> {
    rsLog('mkdir', path);
    path = this.validateAndNormalizePath(path, true);
    try {
      // 创建占位文件，确保目录可见
      try {
        const keepFilePath = joinPath(path, '.keep');
        await this.writeFile(keepFilePath, '');
      } catch (e) {
        // 占位文件写入失败不影响主流程
      }
      const result = {
        ino: 0,
        mode: options?.mode || 0o040755,
        uid: options?.uid || 0,
        gid: options?.gid || 0,
        size: 0,
        mtimeMs: Date.now(),
        ctimeMs: Date.now(),
        atimeMs: Date.now(),
        birthtimeMs: Date.now(),
        nlink: 1,
      };
      rsLogResult('mkdir', path, `mode=${result.mode.toString(8)}`);
      this.invalidateExistenceCache(path);
      // Precisely add this directory's entry to the parent's cached listing.
      const parentPath = getParentPath(path);
      const parentDir = parentPath ? `/${parentPath}/` : '/';
      await this.patchDirListingEntry(parentDir, getBasename(path), {
        name: getBasename(path),
        isDir: true,
        etag: undefined,
      });
      return result;
    } catch (error) {
      rsLogResult('mkdir', path, error, false);
      if (error instanceof FileExistsError || error instanceof RemoteStorageError) {
        throw error;
      }
      throw new RemoteStorageError(
        `Failed to create directory ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Remove directory
   */
  async rmdir(path: string): Promise<void> {
    rsLog('rmdir', path);
    path = this.validateAndNormalizePath(path, true);
    try {
      // Check if directory exists
      const stats = await this.stat(path);
      if (!this.isDirectoryMode(stats.mode)) {
        rsLogResult('rmdir', path, 'Not a directory', false);
        throw new RemoteStorageError(`Not a directory: ${path}`);
      }
      // Check directory entries
      const entries = await this.readdir(path);
      if (entries.length > 1 || (entries.length === 1 && entries[0] !== '.keep')) {
        rsLogResult('rmdir', path, `Directory not empty: [${entries.join(', ')}]`, false);
        throw new RemoteStorageError(`Directory not empty (except .keep): ${path}`);
      }
      // 删除 .keep 占位文件（如果存在）
      if (entries.includes('.keep')) {
        const keepFilePath = joinPath(path, '.keep');
        await this.unlink(keepFilePath);
      }
      rsLogResult('rmdir', path, 'OK');
      this.removeFromExistenceCache(path);
      // Precisely remove this directory's entry from the parent's cached listing.
      const parentPath = getParentPath(path);
      const parentDir = parentPath ? `/${parentPath}/` : '/';
      await this.patchDirListingEntry(parentDir, getBasename(path), null);
      // Also drop the directory's own cached listing.
      this.dirListingCache.delete(normalizePath(path));
      this.scheduleSave();
    } catch (error) {
      rsLogResult('rmdir', path, error, false);
      if (error instanceof FileNotFoundError || error instanceof DirectoryNotFoundError || error instanceof RemoteStorageError) {
        throw error;
      }
      throw new RemoteStorageError(
        `Failed to remove directory ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Remove directory recursively (helper method)
   */
  private async rmdirRecursive(path: string): Promise<void> {
    const entries = await this.readdir(path);
    
    for (const entry of entries) {
      const entryPath = joinPath(path, entry);
      const stats = await this.stat(entryPath);
      
      if (this.isDirectoryMode(stats.mode)) {
        await this.rmdirRecursive(entryPath);
        await this.rmdir(entryPath);
      } else {
        await this.unlink(entryPath);
      }
    }
    
    await this.rmdir(path);
  }

  /**
   * Rename/move file or directory
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    rsLog('rename', oldPath, { to: newPath });
    if (!isValidPath(oldPath) || !isValidPath(newPath)) {
      rsLogResult('rename', oldPath, 'Invalid path format', false);
      throw new RemoteStorageError('Invalid path format');
    }

    try {
      // 检查源文件/目录是否存在
      const stats = await this.stat(oldPath);
      // 检查目标是否已存在
      const destExists = await this.exists(newPath);
      if (destExists) {
        rsLogResult('rename', oldPath, `FileExistsError: ${newPath}`, false);
        throw new FileExistsError(newPath);
      }

      if (this.isFileMode(stats.mode)) {
        // 文件重命名：读内容，写新路径，删旧路径
        const content = await this.readFile(oldPath);
        await this.writeFile(newPath, content);
        await this.unlink(oldPath);
      } else {
        // 目录重命名：递归复制后删除原目录
        await this.copyDirectoryRecursive(oldPath, newPath);
        await this.rmdirRecursive(oldPath);
      }
      rsLogResult('rename', oldPath, `→ ${newPath}`);
    } catch (error) {
      rsLogResult('rename', oldPath, error, false);
      if (error instanceof FileNotFoundError || error instanceof FileExistsError || error instanceof RemoteStorageError) {
        throw error;
      }
      throw new RemoteStorageError(
        `Failed to rename ${oldPath} to ${newPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Helper method to ensure directory exists
   */
  private async ensureDirectoryExists(path: string): Promise<void> {
    const exists = await this.exists(path);
    if (!exists) {
      await this.mkdir(path, { 
        recursive: true,
        uid: 0, 
        gid: 0, 
        mode: 0o040755 
      } as any);
    }
  }

  /**
   * Helper method to copy directory recursively
   */
  private async copyDirectoryRecursive(srcPath: string, destPath: string): Promise<void> {
    await this.mkdir(destPath, { 
      recursive: true,
      uid: 0, 
      gid: 0, 
      mode: 0o040755 
    } as any);
    
    const entries = await this.readdir(srcPath);
    
    for (const entry of entries) {
      const srcEntryPath = joinPath(srcPath, entry);
      const destEntryPath = joinPath(destPath, entry);
      const stats = await this.stat(srcEntryPath);
      
      if (this.isDirectoryMode(stats.mode)) {
        await this.copyDirectoryRecursive(srcEntryPath, destEntryPath);
      } else {
        const content = await this.readFile(srcEntryPath);
        await this.writeFile(destEntryPath, content);
      }
    }
  }

  /**
   * Get filesystem metadata
   */
  metadata() {
    return {
      name: 'RemoteStorageFileSystem',
      readonly: false,
      totalSpace: 0,
      freeSpace: 0,
    };
  }

  /**
   * Sync filesystem (no-op for RemoteStorage as it's always synced)
   */
  async sync(): Promise<void> {
    rsLog('sync', '(root)');
    // RemoteStorage is always synced via HTTP
  }

  /**
   * Disconnect and cleanup
   */
  async disconnect(): Promise<void> {
    rsLog('disconnect', '(root)');
    // Nothing to disconnect for HTTP-based implementation
  }

  // zen-fs required sync methods (throwing not implemented errors)
  statSync(): never {
    throw new Error('Synchronous operations not supported by RemoteStorage');
  }

  readdirSync(): never {
    throw new Error('Synchronous operations not supported by RemoteStorage');
  }

  readFileSync(): never {
    throw new Error('Synchronous operations not supported by RemoteStorage');
  }

  writeFileSync(): never {
    throw new Error('Synchronous operations not supported by RemoteStorage');
  }

  unlinkSync(): never {
    throw new Error('Synchronous operations not supported by RemoteStorage');
  }

  rmdirSync(): never {
    throw new Error('Synchronous operations not supported by RemoteStorage');
  }

  mkdirSync(): never {
    throw new Error('Synchronous operations not supported by RemoteStorage');
  }

  renameSync(): never {
    throw new Error('Synchronous operations not supported by RemoteStorage');
  }

  createFileSync(): never {
    throw new Error('createFileSync operation not supported by RemoteStorage');
  }

  linkSync(): never {
    throw new Error('linkSync operation not supported by RemoteStorage');
  }

  symlink(): Promise<never> {
    return Promise.reject(new Error('symlink operation not supported by RemoteStorage'));
  }

  symlinkSync(): never {
    throw new Error('symlinkSync operation not supported by RemoteStorage');
  }

  readlink(): Promise<never> {
    return Promise.reject(new Error('readlink operation not supported by RemoteStorage'));
  }

  readlinkSync(): never {
    throw new Error('readlinkSync operation not supported by RemoteStorage');
  }

  lstat(): Promise<never> {
    return Promise.reject(new Error('lstat operation not supported by RemoteStorage'));
  }

  lstatSync(): never {
    throw new Error('lstatSync operation not supported by RemoteStorage');
  }

  /**
   * Modify metadata (touch).
   *
   * With precise mtime enabled, writing `mtimeMs` via the `.mtime` sidecar
   * is supported. Other metadata fields are ignored (RemoteStorage protocol
   * does not support them). If precise mtime is disabled, this is a no-op.
   */
  async touch(path: string, metadata: Partial<InodeLike>): Promise<void> {
    rsLog('touch', path, metadata);

    if (this.usePreciseMtime && metadata.mtimeMs !== undefined) {
      path = this.validateAndNormalizePath(path);
      await this.writeMtimeSidecar(path, metadata.mtimeMs);
      rsLogResult('touch', path, `mtimeMs=${metadata.mtimeMs}`);
      return;
    }

    // Without precise mtime, touch is a no-op (RS doesn't support it)
    rsLogResult('touch', path, 'no-op (preciseMtime disabled or no mtimeMs)');
  }

  /**
   * Create the file at path with the given options
   */
  async createFile(path: string, options: CreationOptions): Promise<InodeLike> {
    rsLog('createFile', path);
    await this.writeFile(path, new Uint8Array(0));
    const result = {
      ino: 0,
      mode: options.mode || 0o100644,
      uid: options.uid || 0,
      gid: options.gid || 0,
      size: 0,
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
      atimeMs: Date.now(),
      birthtimeMs: Date.now(),
      nlink: 1,
    };
    rsLogResult('createFile', path, `mode=${result.mode.toString(8)}`);
    this.invalidateExistenceCache(path);
    return result;
  }

  /**
   * Get file/directory stat information
   */
  async stat(path: string): Promise<InodeLike> {
    rsLog('stat', path);
    if (!isValidPath(path)) {
      rsLogResult('stat', path, 'Invalid path format', false);
      throw new RemoteStorageError('Invalid path format');
    }

    const callerSaysDir = path.endsWith('/');
    const baseName = getBasename(path);

    // ---- Stage 0: Existence check via directory listing ----
    // Before any HEAD/GET, check the cached (or freshly fetched) parent
    // directory listing. If the file isn't there, it doesn't exist —
    // no need to waste a HEAD request.
    let existsViaDir = false;
    let isDirViaDir = false;
    let dirListingAvailable = false;
    let cachedEntry: DirEntry | undefined;
    if (baseName) {
      const parentPath = getParentPath(path);
      const parentDir = parentPath ? `/${parentPath}/` : '/';
      let entries = this.getCachedDirListing(parentDir);
      if (entries === null) {
        // Cache miss — fetch directory listing once, cache it for siblings
        try {
          await this.readdir(parentDir);
          entries = this.getCachedDirListing(parentDir);
        } catch {
          entries = null; // parent dir doesn't exist or can't be read
        }
      }
      if (entries) {
        dirListingAvailable = true;
        cachedEntry = entries.get(baseName);
        if (cachedEntry) {
          existsViaDir = true;
          isDirViaDir = cachedEntry.isDir;
        }
      }
    }

    // If parent directory was successfully listed but file is NOT in it,
    // the file definitely doesn't exist — short-circuit.
    if (dirListingAvailable && !existsViaDir && !callerSaysDir) {
      rsLogResult('stat', path, 'FileNotFoundError (not in dir listing)', false);
      throw new FileNotFoundError(path);
    }

    // If the caller explicitly passes a trailing slash, they already know
    // it's a directory — skip the file probe entirely.
    // Try HEAD when: (a) dir listing confirmed file exists but the cached
    // entry lacks size metadata (so we need a real probe), or (b) dir listing
    // wasn't available (parent unreadable) — HEAD as fallback.
    const needMetadata = !cachedEntry || cachedEntry.size === undefined;
    const shouldTryHead = !callerSaysDir && this.headSupported !== false
      && (existsViaDir || !dirListingAvailable) && !isDirViaDir && needMetadata;
    if (shouldTryHead) {
      // ---- Stage 1: HEAD probe (metadata) ----
      // File confirmed to exist via directory listing. Now fetch metadata.
      const fileUrl = this.buildUrl(path);
      try {
        const response = await this.makeRequest(fileUrl, { method: 'HEAD' });
        if (response.ok) {
          this.headSupported = true;
          const contentType = response.headers.get('content-type') || '';
          if (!contentType.includes('application/ld+json') && !contentType.includes('text/html')) {
            const contentLength = response.headers.get('content-length');
            const lastModified = response.headers.get('last-modified');
            const size = contentLength ? parseInt(contentLength, 10) : 0;
            let mtime = lastModified ? new Date(lastModified).getTime() : Date.now();

            if (this.usePreciseMtime) {
              const preciseMtime = await this.readMtimeSidecar(path);
              if (preciseMtime !== undefined) {
                mtime = preciseMtime;
              }
            }

            const result = {
              ino: 0, mode: 0o100644, uid: 0, gid: 0,
              size, mtimeMs: mtime, ctimeMs: mtime, atimeMs: mtime, birthtimeMs: mtime, nlink: 1,
            };
            rsLogResult('stat', path, `FILE mode=${result.mode.toString(8)} size=${size}`);
            this.existenceCache.set(normalizePath(path), { exists: true, ts: Date.now() });
            return result;
          }
        }
        if (response.status === 405) {
          this.headSupported = false;
          rsLog('stat', path, { headStatus: 405, cachedAsUnsupported: true });
        } else if (response.status === 401 || response.status === 403) {
          this.handleHttpError(response, path, 'stat');
        }
        rsLog('stat', path, { headStatus: response.status, fallingThrough: 'readdir stat' });
      } catch (error) {
        if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
          throw error;
        }
        rsLog('stat', path, { headError: error instanceof Error ? error.message : String(error), fallingThrough: 'readdir stat' });
      }
    }

    // ---- Stage 2: Return stat from directory listing or directory probe ----

    // File confirmed as directory via listing
    if (existsViaDir && isDirViaDir) {
      rsLogResult('stat', path, `DIR mode=40755 (via dir listing)`);
      this.existenceCache.set(normalizePath(path), { exists: true, ts: Date.now() });
      return { ino: 0, mode: 0o040755, uid: 0, gid: 0, size: 0,
        mtimeMs: Date.now(), ctimeMs: Date.now(), atimeMs: Date.now(), birthtimeMs: Date.now(), nlink: 1 };
    }

    // File confirmed as regular file via listing. Prefer metadata from the
    // cached directory entry (size / Last-Modified) so we can return without a
    // HEAD request. Fall back to a HEAD probe when metadata is missing.
    if (existsViaDir && !isDirViaDir) {
      const size = cachedEntry?.size ?? 0;
      let mtime = cachedEntry?.lastModified
        ? new Date(cachedEntry.lastModified).getTime()
        : Date.now();

      // Precise mtime sidecar (if enabled) overrides server Last-Modified.
      if (this.usePreciseMtime) {
        const preciseMtime = await this.readMtimeSidecar(path);
        if (preciseMtime !== undefined) {
          mtime = preciseMtime;
        }
      }

      rsLogResult('stat', path, `FILE mode=100644 (via dir listing, size=${size})`);
      this.existenceCache.set(normalizePath(path), { exists: true, ts: Date.now() });
      return { ino: 0, mode: 0o100644, uid: 0, gid: 0, size,
        mtimeMs: mtime, ctimeMs: mtime, atimeMs: mtime, birthtimeMs: mtime, nlink: 1 };
    }

    // File not found in directory listing — but if parent dir wasn't readable,
    // fall back to directory probe (trailing slash GET) as last resort.
    const dirPath = path.endsWith('/') ? path : path + '/';
    const dirUrl = this.buildUrl(dirPath);
    try {
      const response = await this.makeRequest(dirUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/ld+json' },
      });
      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/ld+json') || contentType.includes('text/html')) {
          rsLogResult('stat', path, `DIR mode=40755 (via dir probe)`);
          this.existenceCache.set(normalizePath(path), { exists: true, ts: Date.now() });
          return { ino: 0, mode: 0o040755, uid: 0, gid: 0, size: 0,
            mtimeMs: Date.now(), ctimeMs: Date.now(), atimeMs: Date.now(), birthtimeMs: Date.now(), nlink: 1 };
        }
      }
      if (response.status === 401 || response.status === 403) {
        this.handleHttpError(response, path, 'stat');
      }
    } catch (error) {
      if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
        throw error;
      }
    }

    rsLogResult('stat', path, 'FileNotFoundError', false);
    throw new FileNotFoundError(path);
  }

  /**
   * Freshness-aware file read used by `zen-fs-cache`.
   *
   * Performs a conditional `GET` when validators are supplied, returning
   * `304` (no body) when the content is unchanged so the cache can serve the
   * previously stored bytes. The response's `ETag` / `Last-Modified` are
   * surfaced so the cache can re-validate on the next read.
   */
  async readFileMeta(
    path: string,
    opts?: { ifNoneMatch?: string; ifModifiedSince?: string },
  ): Promise<{ status: number; data?: Uint8Array; etag?: string; lastModified?: string; preciseMtime?: number; contentType?: string }> {
    rsLog('readFileMeta', path, opts);
    path = this.validateAndNormalizePath(path);
    const url = this.buildUrl(path);
    const headers: Record<string, string> = {};
    if (opts?.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;
    else if (opts?.ifModifiedSince) headers['If-Modified-Since'] = opts.ifModifiedSince;

    try {
      const response = await this.makeRequest(url, { method: 'GET', headers });
      if (response.status === 304) {
        rsLogResult('readFileMeta', path, '304 Not Modified');
        return {
          status: 304,
          etag: response.headers.get('ETag') ?? opts?.ifNoneMatch,
          lastModified: response.headers.get('Last-Modified') ?? opts?.ifModifiedSince,
        };
      }
      if (!response.ok) {
        this.handleHttpError(response, path, 'readFileMeta');
      }
      const data = new Uint8Array(await response.arrayBuffer());
      rsLogResult('readFileMeta', path, `200 size=${data.byteLength}`);

      // Read precise mtime from sidecar if enabled
      let preciseMtime: number | undefined;
      if (this.usePreciseMtime) {
        preciseMtime = await this.readMtimeSidecar(path);
      }

      return {
        status: 200,
        data,
        etag: response.headers.get('ETag') ?? undefined,
        lastModified: response.headers.get('Last-Modified') ?? undefined,
        preciseMtime,
        contentType: response.headers.get('Content-Type') ?? undefined,
      };
    } catch (error) {
      rsLogResult('readFileMeta', path, error, false);
      if (error instanceof FileNotFoundError || error instanceof RemoteStorageError) {
        throw error;
      }
      throw new RemoteStorageError(
        `Failed to read file meta ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Return a revision token for any path (file or directory). Used by
   * `zen-fs-cache` for cheap revalidation of `readdir` / `stat` and as a
   * fallback for `readFile`. Prefers the `ETag`, falling back to
   * `Last-Modified` (HTTP-date string).
   */
  async getRevision(path: string): Promise<string | number | undefined> {
    rsLog('getRevision', path);
    path = this.validateAndNormalizePath(path);
    const url = this.buildUrl(path);
    try {
      const response = await this.makeRequest(url, { method: 'HEAD' });
      if (!response.ok) {
        rsLogResult('getRevision', path, `status=${response.status}`);
        return undefined;
      }
      const rev = response.headers.get('ETag') ?? response.headers.get('Last-Modified') ?? undefined;
      rsLogResult('getRevision', path, rev);
      return rev;
    } catch (err) {
      rsLogResult('getRevision', path, err, false);
      return undefined;
    }
  }

  /**
   * Hard link operation (not supported)
   */
  async link(target: string, link: string): Promise<void> {
    rsLog('link', target, { link });
    throw new Error('Link operation not supported by RemoteStorage');
  }

  /**
   * Read into a buffer
   */
  async read(path: string, buffer: Uint8Array, start: number, end: number): Promise<void> {
    rsLog('read', path, { start, end, bufLen: buffer.length });
    const data = await this.readFile(path);
    const slice = data.slice(start, end);
    buffer.set(slice, 0);
    rsLogResult('read', path, `copied=${slice.length}`);
  }

  /**
   * Write a buffer to a file
   */
  async write(path: string, buffer: Uint8Array, offset: number): Promise<void> {
    rsLog('write', path, { offset, len: buffer.length });
    // For simplicity, we'll read the entire file, modify it, and write it back
    let existingData: Uint8Array;

    try {
      existingData = await this.readFile(path);
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        existingData = new Uint8Array(0);
      } else {
        throw error;
      }
    }

    // Extend the file if necessary
    const newSize = Math.max(existingData.length, offset + buffer.length);
    const newData = new Uint8Array(newSize);

    // Copy existing data
    newData.set(existingData);

    // Write new data at offset
    newData.set(buffer, offset);

    await this.writeFile(path, newData);
    rsLogResult('write', path, `newSize=${newSize}`);
  }

  /**
   * Check if mode indicates a directory
   */
  private isDirectoryMode(mode: number): boolean {
    return (mode & 0o040000) === 0o040000;
  }

  /**
   * Check if mode indicates a regular file
   */
  private isFileMode(mode: number): boolean {
    return (mode & 0o100000) === 0o100000;
  }

  // Additional required sync methods
  touchSync(): never {
    throw new Error('Synchronous operations not supported by RemoteStorage');
  }

  syncSync(): never {
    throw new Error('Synchronous operations not supported by RemoteStorage');
  }

  readSync(): never {
    throw new Error('Synchronous operations not supported by RemoteStorage');
  }

  writeSync(): never {
    throw new Error('Synchronous operations not supported by RemoteStorage');
  }

  /**
   * Invalidate existence cache for a path and all its ancestors.
   * Called after writes, creates, and deletes.
   */
  private invalidateExistenceCache(path: string): void {
    const normalized = normalizePath(path);
    this.existenceCache.delete(normalized);
    // Also invalidate the parent directory's existence entry (readdir may change)
    this.existenceCache.delete(ensureDirectoryPath(getParentPath(normalized)));
    // NOTE: directory-listing cache is NOT dropped here. Writes/deletes patch
    // the affected entry precisely via patchDirListingEntry() so siblings stay
    // valid (ETag-based fine-grained invalidation).
    // Mark the path itself as existing (it was just written/created)
    this.existenceCache.set(normalized, { exists: true, ts: Date.now() });
  }

  /**
   * Remove a path from the existence cache (after deletion).
   */
  private removeFromExistenceCache(path: string): void {
    const normalized = normalizePath(path);
    this.existenceCache.delete(normalized);
    // Also invalidate parent's existence entry
    this.existenceCache.delete(ensureDirectoryPath(getParentPath(normalized)));
    // Directory-listing cache entry is removed precisely by callers (unlink/rmdir).
  }

  // -------------------------------------------------------------------------
  // Directory listing cache management
  // -------------------------------------------------------------------------

  /**
   * Get the cached directory listing for a directory path, or null if
   * not cached / expired. Does NOT make any network requests.
   *
   * ETag-based invalidation: a cached entry is considered stale only when its
   * directory ETag differs from `currentDirEtag` (when provided) — not on every
   * write. A long TTL acts as a fallback for servers that don't return ETags.
   */
  private getCachedDirListing(dirPath: string): Map<string, DirEntry> | null {
    const key = normalizePath(dirPath);
    const cached = this.dirListingCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.ts >= RemoteStorageFileSystem.DIR_LISTING_TTL) {
      this.dirListingCache.delete(key); // long-TTL fallback expiry
      return null;
    }
    return cached.entries;
  }

  /**
   * Cache a directory listing result (with per-entry metadata) and the
   * directory's own ETag. Replaces any previous listing for this directory.
   */
  private cacheDirListing(
    dirPath: string,
    entries: DirEntry[],
    dirEtag: string | null,
  ): void {
    const key = normalizePath(dirPath);
    const map = new Map<string, DirEntry>();
    for (const e of entries) {
      map.set(e.name, e);
    }
    this.dirListingCache.set(key, { etag: dirEtag, ts: Date.now(), entries: map });
    this.scheduleSave();
  }

  /**
   * Precisely patch a single child entry inside a parent directory's cached
   * listing — used after a local write/delete so siblings stay valid. This is
   * the ETag-based fine-grained invalidation (no whole-directory drop).
   */
  private async patchDirListingEntry(
    parentDir: string,
    name: string,
    entry: DirEntry | null,
  ): Promise<void> {
    // Ensure any persisted cache has been restored before patching, so we
    // don't accidentally drop entries that were loaded from storage.
    await this.ensureCacheLoaded();
    const key = normalizePath(parentDir);
    const cached = this.dirListingCache.get(key);
    if (!cached) return; // nothing cached for this dir; will be fetched on demand
    if (entry === null) {
      cached.entries.delete(name);
    } else {
      cached.entries.set(name, entry);
    }
    cached.ts = Date.now();
    this.scheduleSave();
  }

  /**
   * Ensure the persisted cache has been loaded from storage at least once.
   * Memoized — the actual load runs a single time per instance.
   */
  private ensureCacheLoaded(): Promise<void> {
    if (!this.persistCache || !this.storage) return Promise.resolve();
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const blob = await this.storage!.load();
          const data = blob[this.cacheNamespace];
          if (data && typeof data === 'object') {
            const parsed = data as Record<string, { etag: string | null; ts: number; entries: Record<string, DirEntry> }>;
            for (const [k, v] of Object.entries(parsed)) {
              const m = new Map<string, DirEntry>();
              for (const [name, e] of Object.entries(v.entries)) {
                m.set(name, e);
              }
              this.dirListingCache.set(k, { etag: v.etag, ts: v.ts, entries: m });
            }
            rsLogResult('cache', 'load', `restored ${this.dirListingCache.size} dirs`);
          }
        } catch (err) {
          rsLogResult('cache', 'load', err, false);
        }
      })();
    }
    return this.loadPromise;
  }

  /**
   * Debounced persistence of the whole directory cache blob.
   */
  private scheduleSave(): void {
    if (!this.persistCache || !this.storage) return;
    if (this.saveTimer) return; // already scheduled
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushSave();
    }, 500);
  }

  private async flushSave(): Promise<void> {
    try {
      const blob = await this.storage!.load();
      const out: Record<string, { etag: string | null; ts: number; entries: Record<string, DirEntry> }> = {};
      for (const [k, v] of this.dirListingCache.entries()) {
        const entries: Record<string, DirEntry> = {};
        for (const [name, e] of v.entries.entries()) {
          entries[name] = e;
        }
        out[k] = { etag: v.etag, ts: v.ts, entries };
      }
      blob[this.cacheNamespace] = out;
      await this.storage!.save(blob);
      rsLogResult('cache', 'save', `persisted ${this.dirListingCache.size} dirs`);
    } catch (err) {
      rsLogResult('cache', 'save', err, false);
    }
  }

  /**
   * Clear the entire existence cache.
   */
  clearExistenceCache(): void {
    this.existenceCache.clear();
    this.dirListingCache.clear();
    this.scheduleSave();
  }

  // ===========================================================================
  // Precise mtime — .mtime sidecar file management
  // ===========================================================================

  /**
   * Write (or overwrite) the `.mtime` sidecar file for `filePath`.
   *
   * The sidecar stores `{ "mtime": <ms> }` and is invisible to upper layers
   * (filtered from readdir, excluded from sync).
   */
  private async writeMtimeSidecar(filePath: string, mtime: number): Promise<void> {
    const sidecarPath = mtimePathFor(filePath);
    const sidecarUrl = this.buildUrl(sidecarPath);
    const body = JSON.stringify({ mtime });
    try {
      const headers = new Headers(this.headers);
      headers.set('Content-Type', 'application/json');
      const response = await this.makeRequest(sidecarUrl, {
        method: 'PUT',
        body,
        headers,
      });
      if (!response.ok) {
        rsLogResult('writeMtimeSidecar', filePath, `status=${response.status}`, false);
      } else {
        // Update in-memory cache
        const normalized = normalizePath(filePath);
        this.mtimeCache.set(normalized, mtime);
        // Persist to IndexedDB
        this.mtimeStore.set(normalized, mtime).catch(() => {});
        rsLogResult('writeMtimeSidecar', filePath, `mtime=${mtime}`);
      }
    } catch (error) {
      // Sidecar write failure is non-fatal — log and continue
      rsLogResult('writeMtimeSidecar', filePath, error, false);
    }
  }

  /**
   * Read the `.mtime` sidecar for `filePath` and return the precise mtime
   * in milliseconds, or `undefined` if the sidecar does not exist / cannot
   * be parsed.
   *
   * Checks in-memory cache first, then IndexedDB (for cross-session
   * persistence), then falls back to a network GET.
   */
  private async readMtimeSidecar(filePath: string): Promise<number | undefined> {
    const normalized = normalizePath(filePath);

    // 1. Check in-memory cache first
    const cached = this.mtimeCache.get(normalized);
    if (cached !== undefined) {
      return cached;
    }

    // 2. Check IndexedDB (may have been persisted in a previous session)
    const idbCached = await this.mtimeStore.get<number>(normalized);
    if (idbCached !== undefined) {
      this.mtimeCache.set(normalized, idbCached);
      return idbCached;
    }

    // 3. Fetch from remote
    const sidecarPath = mtimePathFor(filePath);
    const sidecarUrl = this.buildUrl(sidecarPath);
    try {
      const response = await this.makeRequest(sidecarUrl, { method: 'GET' });
      if (!response.ok) {
        return undefined;
      }
      const text = await response.text();
      const parsed = JSON.parse(text);
      if (typeof parsed.mtime === 'number') {
        this.mtimeCache.set(normalized, parsed.mtime);
        // Persist to IndexedDB
        this.mtimeStore.set(normalized, parsed.mtime).catch(() => {});
        return parsed.mtime;
      }
      return undefined;
    } catch {
      // Sidecar missing or unreadable — fall back to server Last-Modified
      return undefined;
    }
  }

  /**
   * Delete the `.mtime` sidecar for `filePath`. Called from `unlink()`.
   * Failure is non-fatal — a stale sidecar just means stat() will return
   * the server's Last-Modified instead.
   */
  private async deleteMtimeSidecar(filePath: string): Promise<void> {
    const sidecarPath = mtimePathFor(filePath);
    const sidecarUrl = this.buildUrl(sidecarPath);
    const normalized = normalizePath(filePath);
    try {
      const response = await this.makeRequest(sidecarUrl, { method: 'DELETE' });
      if (response.ok || response.status === 404) {
        this.mtimeCache.delete(normalized);
        this.mtimeStore.delete(normalized).catch(() => {});
        rsLogResult('deleteMtimeSidecar', filePath, 'OK');
      }
    } catch {
      // Non-fatal
    }
  }

  // ===========================================================================
  // Snapshot — ETag baseline for shouldSync()
  // ===========================================================================

  /**
   * Implement `zen-fs-sync`'s `SyncableFS.shouldSync()` interface.
   *
   * Compares the in-memory ETag baseline (snapshot) with the actual remote
   * state. Returns `true` when remote changes are detected (or on first call
   * when no baseline exists). The snapshot is rebuilt as a side effect.
   *
   * On first call, attempts to restore the snapshot from IndexedDB. If the
   * persisted rootEtag still matches the remote root, returns `false` —
   * skipping the expensive full tree walk.
   */
  async shouldSync(): Promise<boolean> {
    rsLog('shouldSync', '(snapshot check)');

    // First call — try restoring from IndexedDB before building from scratch
    if (this.snapshot === null) {
      // Attempt to restore snapshot from IndexedDB
      await this.loadSnapshotFromIDB();

      if (this.snapshot !== null && this.rootEtag !== null) {
        // Snapshot restored — check if root ETag is still the same
        const currentRootEtag = await this.fetchRootEtag();
        if (currentRootEtag !== null && currentRootEtag === this.rootEtag) {
          rsLogResult('shouldSync', '', 'false (snapshot restored from IDB, root ETag unchanged)');
          return false;
        }
        // Root ETag changed (or unavailable) — rebuild snapshot with pruning
        await this.buildSnapshot();
        rsLogResult('shouldSync', '', 'true (snapshot restored but root ETag changed)');
        return true;
      }

      // No persisted snapshot — build one from scratch and signal full sync
      await this.buildSnapshot();
      rsLogResult('shouldSync', '', 'true (first call, baseline built)');
      return true;
    }

    // Quick check: HEAD root folder and compare ETag
    const currentRootEtag = await this.fetchRootEtag();
    if (currentRootEtag === null) {
      // Couldn't fetch root ETag — err on the side of syncing
      rsLogResult('shouldSync', '', 'true (root ETag unavailable)');
      return true;
    }

    if (currentRootEtag === this.rootEtag) {
      rsLogResult('shouldSync', '', 'false (root ETag unchanged)');
      return false;
    }

    // Root ETag changed — rebuild snapshot (with subtree pruning) and sync
    await this.buildSnapshot();
    rsLogResult('shouldSync', '', 'true (root ETag changed)');
    return true;
  }

  /**
   * Fetch only the root folder's ETag via a HEAD request.
   * Returns `null` if the request fails or no ETag is present.
   */
  private async fetchRootEtag(): Promise<string | null> {
    const rootUrl = this.buildUrl('/');
    try {
      const response = await this.makeRequest(rootUrl, { method: 'HEAD' });
      if (!response.ok) {
        return null;
      }
      return response.headers.get('ETag');
    } catch {
      return null;
    }
  }

  /**
   * Build (or rebuild) the in-memory snapshot by walking the remote folder
   * tree and recording ETags for every document and folder.
   *
   * Uses subtree pruning: if a subfolder's ETag hasn't changed since the
   * previous snapshot, its subtree is skipped entirely.
   *
   * After building, persists the snapshot and rootEtag to IndexedDB so that
   * the next session can skip the full tree walk if the root ETag is unchanged.
   */
  private async buildSnapshot(): Promise<void> {
    rsLog('buildSnapshot', '(building ETag baseline)');

    const previousSnapshot = this.snapshot;
    const previousRootEtag = this.rootEtag;

    this.snapshot = new Map<string, string>();

    // Fetch root folder listing
    const rootEtag = await this.fetchRootEtag();
    this.rootEtag = rootEtag;

    await this.buildSnapshotRecursive('/', previousSnapshot);

    rsLogResult('buildSnapshot', '', `entries=${this.snapshot.size}`);

    // Persist snapshot and rootEtag to IndexedDB (fire-and-forget)
    this.persistSnapshotToIDB();
  }

  /**
   * Load the ETag snapshot and rootEtag from IndexedDB into memory.
   * Called once on the first shouldSync() call to enable a warm start.
   * Sets `snapshotLoaded` to true regardless of whether data was found.
   */
  private async loadSnapshotFromIDB(): Promise<void> {
    if (this.snapshotLoaded) return;
    this.snapshotLoaded = true;

    try {
      const [entries, rootEtag] = await Promise.all([
        this.snapshotStore.entries<string>(),
        this.snapshotStore.get<string>('__rootEtag__'),
      ]);

      if (entries.length > 0) {
        this.snapshot = new Map<string, string>();
        for (const [path, etag] of entries) {
          if (path !== '__rootEtag__') {
            this.snapshot.set(path, etag);
          }
        }
        this.rootEtag = rootEtag ?? null;
        rsLogResult('shouldSync', '', `restored snapshot from IDB: ${this.snapshot.size} entries, rootEtag=${this.rootEtag}`);
      }
    } catch {
      // IndexedDB unavailable — fall through to building from scratch
    }
  }

  /**
   * Persist the current snapshot and rootEtag to IndexedDB (fire-and-forget).
   * Called after buildSnapshot() and updateSnapshotForPath().
   */
  private persistSnapshotToIDB(): void {
    if (this.snapshot === null) return;
    // Store rootEtag under a reserved key
    const entries: [string, string][] = [['__rootEtag__', this.rootEtag ?? '']];
    for (const [path, etag] of this.snapshot) {
      entries.push([path, etag]);
    }
    this.snapshotStore.setMany(entries).catch(() => {});
  }

  /**
   * Recursive helper for `buildSnapshot()`. Walks a folder, stores ETags for
   * all items, and prunes subtrees whose ETag is unchanged from the previous
   * snapshot.
   */
  private async buildSnapshotRecursive(
    dirPath: string,
    previousSnapshot: Map<string, string> | null,
  ): Promise<void> {
    const dirUrl = this.buildUrl(ensureDirectoryPath(dirPath));
    try {
      const response = await this.makeRequest(dirUrl, {
        method: 'GET',
        headers: { Accept: 'application/ld+json' },
      });
      if (!response.ok) {
        return;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/ld+json')) {
        return;
      }

      const listing = await response.json();
      const items: { name: string; etag?: string; isDir: boolean }[] = [];

      if (listing['@graph']) {
        for (const item of listing['@graph']) {
          if (item['@id'] && item['@id'] !== './') {
            const rawName = item['@id'];
            const isDir = rawName.endsWith('/');
            const name = isDir ? rawName.slice(0, -1) : rawName;
            if (name) {
              items.push({ name, etag: item['ETag'] ?? item['etag'], isDir });
            }
          }
        }
      } else if (listing['items'] && typeof listing['items'] === 'object') {
        for (const entryKey of Object.keys(listing['items'])) {
          if (entryKey && entryKey !== './') {
            const isDir = entryKey.endsWith('/');
            const name = isDir ? entryKey.slice(0, -1) : entryKey;
            const item = listing['items'][entryKey];
            if (name) {
              items.push({ name, etag: item?.ETag ?? item?.etag, isDir });
            }
          }
        }
      }

      for (const item of items) {
        const itemPath = dirPath === '/' ? item.name : `${dirPath}/${item.name}`;

        // Skip .mtime sidecar files — they are internal
        if (isMtimeSidecar(item.name)) {
          continue;
        }

        // Store ETag in snapshot
        if (item.etag) {
          this.snapshot!.set(itemPath, item.etag);
        }

        if (item.isDir) {
          // Subtree pruning: if this folder's ETag is unchanged from the
          // previous snapshot, skip recursing into it
          const prevEtag = previousSnapshot?.get(itemPath);
          if (prevEtag && item.etag && prevEtag === item.etag) {
            // Copy all previous entries under this subtree
            const prefix = itemPath + '/';
            for (const [prevPath, prevVal] of previousSnapshot!) {
              if (prevPath.startsWith(prefix) || prevPath === itemPath) {
                this.snapshot!.set(prevPath, prevVal);
              }
            }
            continue;
          }
          // ETag changed (or no previous data) — recurse
          await this.buildSnapshotRecursive(itemPath, previousSnapshot);
        }
      }
    } catch {
      // Network errors on a subfolder are non-fatal for snapshot building
    }
  }

  /**
   * Update the in-memory snapshot after a local write or delete.
   * Called internally by `writeFile()` and `unlink()`.
   *
   * Persists the change to IndexedDB so the snapshot stays consistent across
   * page reloads.
   */
  private updateSnapshotForPath(path: string, etag: string | null): void {
    if (this.snapshot === null) {
      // Snapshot not yet built — nothing to update
      return;
    }

    const normalized = normalizePath(path);
    if (etag === null) {
      this.snapshot.delete(normalized);
      this.snapshotStore.delete(normalized).catch(() => {});
    } else {
      this.snapshot.set(normalized, etag);
      this.snapshotStore.set(normalized, etag).catch(() => {});
    }
    // Mark rootEtag as stale — we just modified a file on the remote
    this.rootEtag = null;
    this.snapshotStore.set('__rootEtag__', '').catch(() => {});
  }
}
