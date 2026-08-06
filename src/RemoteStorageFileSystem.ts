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
        body = data;
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

      // Update snapshot with new ETag from PUT response
      const newEtag = response.headers.get('ETag') ?? undefined;
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
   * Delete file
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
      let items: string[];
      if (contentType.includes('application/ld+json')) {
        const listing = await response.json();
        items = [];
        if (listing['@graph']) {
          for (const item of listing['@graph']) {
            if (item['@id'] && item['@id'] !== './') {
              const name = item['@id'].replace(/\/$/, '');
              if (name) {
                items.push(name);
              }
            }
          }
        } else if (listing['items'] && typeof listing['items'] === 'object') {
          for (const entryKey of Object.keys(listing['items'])) {
            if (entryKey && entryKey !== './') {
              items.push(entryKey.replace(/\/$/, ''));
            }
          }
        }
      } else {
        const html = await response.text();
        items = this.parseHtmlDirectoryListing(html);
      }
      // Filter out .mtime sidecar files — they are internal to RemoteStorageFileSystem
      const filtered = items.filter(name => !isMtimeSidecar(name));
      rsLogResult('readdir', path, `count=${filtered.length} [${filtered.join(', ')}]`);
      this.existenceCache.set(normalizePath(path), { exists: true, ts: Date.now() });
      return filtered;
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

    // If the caller explicitly passes a trailing slash, they already know
    // it's a directory — skip the file probe entirely.
    const callerSaysDir = path.endsWith('/');

    if (!callerSaysDir) {
      // Try as file first (most common case) — no trailing slash
      const fileUrl = this.buildUrl(path);
      try {
        const response = await this.makeRequest(fileUrl, { method: 'HEAD' });
        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';
          // If HEAD returns a directory content-type, don't treat it as a file
          if (!contentType.includes('application/ld+json') && !contentType.includes('text/html')) {
            const contentLength = response.headers.get('content-length');
            const lastModified = response.headers.get('last-modified');
            const size = contentLength ? parseInt(contentLength, 10) : 0;
            let mtime = lastModified ? new Date(lastModified).getTime() : Date.now();

            // If precise mtime is enabled, try to read the .mtime sidecar
            // for millisecond-precision mtime
            if (this.usePreciseMtime) {
              const preciseMtime = await this.readMtimeSidecar(path);
              if (preciseMtime !== undefined) {
                mtime = preciseMtime;
              }
            }

            const result = {
              ino: 0,
              mode: 0o100644,
              uid: 0,
              gid: 0,
              size,
              mtimeMs: mtime,
              ctimeMs: mtime,
              atimeMs: mtime,
              birthtimeMs: mtime,
              nlink: 1,
            };
            rsLogResult('stat', path, `FILE mode=${result.mode.toString(8)} size=${size}`);
            this.existenceCache.set(normalizePath(path), { exists: true, ts: Date.now() });
            return result;
          }
        }
        // 404 → not a file, try as directory below
        if (response.status !== 404) {
          this.handleHttpError(response, path, 'stat');
        }
      } catch (error) {
        if (error instanceof RemoteStorageError && !(error instanceof FileNotFoundError)) {
          throw error;
        }
        // FileNotFoundError or network error → try as directory
      }
    }

    // Try as directory — trailing slash required by RemoteStorage spec
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
          rsLogResult('stat', path, `DIR mode=40755`);
          this.existenceCache.set(normalizePath(path), { exists: true, ts: Date.now() });
          return {
            ino: 0,
            mode: 0o040755,
            uid: 0,
            gid: 0,
            size: 0,
            mtimeMs: Date.now(),
            ctimeMs: Date.now(),
            atimeMs: Date.now(),
            birthtimeMs: Date.now(),
            nlink: 1,
          };
        }
      }
      if (response.status === 404) {
        rsLogResult('stat', path, 'FileNotFoundError', false);
        throw new FileNotFoundError(path);
      }
      this.handleHttpError(response, path, 'stat');
    } catch (error) {
      rsLogResult('stat', path, error, false);
      if (error instanceof FileNotFoundError || error instanceof RemoteStorageError) {
        throw error;
      }
      throw new RemoteStorageError(
        `Failed to stat ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Should not reach here
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
    // Also invalidate the parent directory (readdir results may change)
    this.existenceCache.delete(ensureDirectoryPath(getParentPath(normalized)));
    // Mark the path itself as existing (it was just written/created)
    this.existenceCache.set(normalized, { exists: true, ts: Date.now() });
  }

  /**
   * Remove a path from the existence cache (after deletion).
   */
  private removeFromExistenceCache(path: string): void {
    const normalized = normalizePath(path);
    this.existenceCache.delete(normalized);
    // Also invalidate parent
    this.existenceCache.delete(ensureDirectoryPath(getParentPath(normalized)));
  }

  /**
   * Clear the entire existence cache.
   */
  clearExistenceCache(): void {
    this.existenceCache.clear();
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
        this.mtimeCache.set(normalizePath(filePath), mtime);
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
   */
  private async readMtimeSidecar(filePath: string): Promise<number | undefined> {
    const normalized = normalizePath(filePath);

    // Check in-memory cache first
    const cached = this.mtimeCache.get(normalized);
    if (cached !== undefined) {
      return cached;
    }

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
    try {
      const response = await this.makeRequest(sidecarUrl, { method: 'DELETE' });
      if (response.ok || response.status === 404) {
        this.mtimeCache.delete(normalizePath(filePath));
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
   */
  async shouldSync(): Promise<boolean> {
    rsLog('shouldSync', '(snapshot check)');

    // First call — no baseline exists, build one and signal full sync
    if (this.snapshot === null) {
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
   */
  private updateSnapshotForPath(path: string, etag: string | null): void {
    if (this.snapshot === null) {
      // Snapshot not yet built — nothing to update
      return;
    }

    const normalized = normalizePath(path);
    if (etag === null) {
      this.snapshot.delete(normalized);
    } else {
      this.snapshot.set(normalized, etag);
    }
    // Mark rootEtag as stale — we just modified a file on the remote
    this.rootEtag = null;
  }
}
