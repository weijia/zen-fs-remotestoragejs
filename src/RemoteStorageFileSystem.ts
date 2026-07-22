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
} from './utils.js';

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
  }

  /**
   * Build full URL for a path
   */
  private buildUrl(path: string): string {
    const basePath = this.config.basePath || '';
    const normalizedPath = normalizePath(path);
    // RemoteStorage spec: directory URLs must end with '/'
    const isDir = path === '/' || path.endsWith('/');
    const suffix = normalizedPath
      ? '/' + normalizedPath
      : (isDir ? '/' : '');
    // Avoid double slashes when basePath ends with '/' and suffix starts with '/'
    const fullPath = basePath.endsWith('/') && suffix.startsWith('/')
      ? basePath + suffix.slice(1)
      : basePath + suffix;
    return this.baseUrl + fullPath;
  }

  /**
   * Make HTTP request with timeout
   */
  private async makeRequest(url: string, options: RequestInit = {}): Promise<Response> {
    const maxRetries = 3;
    let lastError: any = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            'Authorization': `Bearer ${this.config.token}`,
            'Content-Type': 'application/json',
            ...this.config.headers,
            ...options.headers,
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error;
        // 只对网络错误/超时重试，其他错误直接抛出
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
    // 如果重试后仍失败，抛出最后的错误
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
      // 只对目录路径加/，文件路径保持原样
      const dirUrl = this.buildUrl(path);
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
    try {
      await this.stat(path);
      return true;
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Read file contents
   */
  async readFile(path: string): Promise<Uint8Array> {
    path = this.validateAndNormalizePath(path);
    const url = this.buildUrl(path);
    try {
      const response = await this.makeRequest(url, { method: 'GET' });
      if (!response.ok) {
        this.handleHttpError(response, path, 'readFile');
      }
      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    } catch (error) {
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
  async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: { flag?: string }): Promise<void> {
    path = this.validateAndNormalizePath(path);
    const flag = options?.flag;
    // Check if file exists for exclusive flags
    if (flag === 'x' || flag === 'wx') {
      const exists = await this.exists(path);
      if (exists) {
        throw new FileExistsError(path);
      }
    }
    const url = this.buildUrl(path);
    console.log(`[RemoteStorage] writeFile path=${path} url=${url} size=${typeof data === 'string' ? data.length : (data as Uint8Array).byteLength}`);
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
    } catch (error) {
      if (error instanceof FileExistsError || error instanceof RemoteStorageError) {
        throw error;
      }
      throw new RemoteStorageError(
        `Failed to write file ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Delete file
   */
  async unlink(path: string): Promise<void> {
    path = this.validateAndNormalizePath(path);
    try {
      const url = this.buildUrl(path);
      const response = await this.makeRequest(url, { method: 'DELETE' });
      if (!response.ok) {
        this.handleHttpError(response, path, 'unlink');
      }
    } catch (error) {
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
    path = this.validateAndNormalizePath(path, true);
    const dirUrl = this.buildUrl(path);
    try {
      const response = await this.makeRequest(dirUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/ld+json' },
      });
      if (!response.ok) {
        // Remote directory not found = empty directory, return []
        if (response.status === 404) {
          return [];
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
      return items;
    } catch (error) {
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
  async mkdir(path: string, options: CreationOptions): Promise<InodeLike> {
    path = this.validateAndNormalizePath(path, true);
    try {
      // 创建占位文件，确保目录可见
      try {
        const keepFilePath = joinPath(path, '.keep');
        await this.writeFile(keepFilePath, '');
      } catch (e) {
        // 占位文件写入失败不影响主流程
      }
      return {
        ino: 0,
        mode: options.mode || 0o040755,
        uid: options.uid || 0,
        gid: options.gid || 0,
        size: 0,
        mtimeMs: Date.now(),
        ctimeMs: Date.now(),
        atimeMs: Date.now(),
        birthtimeMs: Date.now(),
        nlink: 1,
      };
    } catch (error) {
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
    path = this.validateAndNormalizePath(path, true);
    try {
      // Check if directory exists
      const stats = await this.stat(path);
      if (!this.isDirectoryMode(stats.mode)) {
        throw new RemoteStorageError(`Not a directory: ${path}`);
      }
      // Check directory entries
      const entries = await this.readdir(path);
      if (entries.length > 1 || (entries.length === 1 && entries[0] !== '.keep')) {
        throw new RemoteStorageError(`Directory not empty (except .keep): ${path}`);
      }
      // 删除 .keep 占位文件（如果存在）
      if (entries.includes('.keep')) {
        const keepFilePath = joinPath(path, '.keep');
        await this.unlink(keepFilePath);
      }
    } catch (error) {
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
    if (!isValidPath(oldPath) || !isValidPath(newPath)) {
      throw new RemoteStorageError('Invalid path format');
    }

    try {
      // 检查源文件/目录是否存在
      const stats = await this.stat(oldPath);
      // 检查目标是否已存在
      const destExists = await this.exists(newPath);
      if (destExists) {
        throw new FileExistsError(newPath);
      }

      if (this.isFileMode(stats.mode)) {
        // 文件重命名：读内容，写新路径，删旧路径（此处已知 oldPath 一定是文件，无需 unlink 再 stat）
        const content = await this.readFile(oldPath);
        await this.writeFile(newPath, content);
        // 写入和删除之间等待一段时间，避免远端同步延迟导致删除失败
        // await new Promise(resolve => setTimeout(resolve, 1000));
        await this.unlink(oldPath); // unlink 已优化，无需再 stat
      } else {
        // 目录重命名：递归复制后删除原目录
        await this.copyDirectoryRecursive(oldPath, newPath);
        await this.rmdirRecursive(oldPath);
      }
    } catch (error) {
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
    // RemoteStorage is always synced via HTTP
  }

  /**
   * Disconnect and cleanup
   */
  async disconnect(): Promise<void> {
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
   * Modify metadata (touch)
   */
  async touch(path: string, metadata: Partial<InodeLike>): Promise<void> {
    throw new Error('Touch operation not supported by RemoteStorage');
  }

  /**
   * Create the file at path with the given options
   */
  async createFile(path: string, options: CreationOptions): Promise<InodeLike> {
    // Create an empty file
    await this.writeFile(path, new Uint8Array(0));
    
    // Return the created file inode
    return {
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
  }

  /**
   * Get file/directory stat information
   */
  async stat(path: string): Promise<InodeLike> {
    if (!isValidPath(path)) {
      throw new RemoteStorageError('Invalid path format');
    }

    // RemoteStorage servers require directory URLs to end with '/'.
    // Callers (e.g. zen-fs-sync) pass paths without trailing slash.
    // We detect directory vs file here so the caller never needs to care.
    try {
      const entries = await this.readdir(path);
      if (entries.length >= 0) {
        // readdir succeeded → it's a directory
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
    } catch {
      // Not a directory, try as file
    }

    // Try as file
    const url = this.buildUrl(path);
    try {
      const response = await this.makeRequest(url, { method: 'HEAD' });
      if (!response.ok) {
        this.handleHttpError(response, path, 'stat');
      }

      const contentLength = response.headers.get('content-length');
      const lastModified = response.headers.get('last-modified');
      const size = contentLength ? parseInt(contentLength, 10) : 0;
      const mtime = lastModified ? new Date(lastModified).getTime() : Date.now();

      return {
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
    } catch (error) {
      if (error instanceof FileNotFoundError || error instanceof RemoteStorageError) {
        throw error;
      }
      throw new RemoteStorageError(
        `Failed to stat ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
  ): Promise<{ status: number; data?: Uint8Array; etag?: string; lastModified?: string; contentType?: string }> {
    path = this.validateAndNormalizePath(path);
    const url = this.buildUrl(path);
    const headers: Record<string, string> = {};
    if (opts?.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;
    else if (opts?.ifModifiedSince) headers['If-Modified-Since'] = opts.ifModifiedSince;

    try {
      const response = await this.makeRequest(url, { method: 'GET', headers });
      if (response.status === 304) {
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
      return {
        status: 200,
        data,
        etag: response.headers.get('ETag') ?? undefined,
        lastModified: response.headers.get('Last-Modified') ?? undefined,
        contentType: response.headers.get('Content-Type') ?? undefined,
      };
    } catch (error) {
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
    path = this.validateAndNormalizePath(path);
    const url = this.buildUrl(path);
    try {
      const response = await this.makeRequest(url, { method: 'HEAD' });
      if (!response.ok) return undefined;
      return response.headers.get('ETag') ?? response.headers.get('Last-Modified') ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Hard link operation (not supported)
   */
  async link(target: string, link: string): Promise<void> {
    throw new Error('Link operation not supported by RemoteStorage');
  }

  /**
   * Read into a buffer
   */
  async read(path: string, buffer: Uint8Array, start: number, end: number): Promise<void> {
    const data = await this.readFile(path);
    const slice = data.slice(start, end);
    buffer.set(slice, 0);
  }

  /**
   * Write a buffer to a file
   */
  async write(path: string, buffer: Uint8Array, offset: number): Promise<void> {
    // For simplicity, we'll read the entire file, modify it, and write it back
    // This is not efficient for large files but works for the RemoteStorage use case
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
}
