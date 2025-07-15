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
  private baseUrl: string;
  private headers: Headers;
  private timeout: number;

  constructor(private config: RemoteStorageConfig) {
    super(0 as any, 0 as any); // FileSystem constructor - using type assertion for now
    
    // Normalize base URL
    this.baseUrl = config.href.endsWith('/') ? config.href.slice(0, -1) : config.href;
    
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
    const fullPath = basePath + (normalizedPath ? '/' + normalizedPath : '');
    return this.baseUrl + fullPath;
  }

  /**
   * Make HTTP request with timeout
   */
  private async makeRequest(url: string, options: RequestInit = {}): Promise<Response> {
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
      if (error instanceof Error && error.name === 'AbortError') {
        throw new RemoteStorageError('Request timeout');
      }
      throw error;
    }
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
      const dirUrl = this.buildUrl(ensureDirectoryPath(path));
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
    if (!isValidPath(path)) {
      throw new RemoteStorageError('Invalid path format');
    }

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
    if (!isValidPath(path)) {
      throw new RemoteStorageError('Invalid path format');
    }

    const flag = options?.flag;
    
    // Check if file exists for exclusive flags
    if (flag === 'x' || flag === 'wx') {
      const exists = await this.exists(path);
      if (exists) {
        throw new FileExistsError(path);
      }
    }

    const url = this.buildUrl(path);
    
    try {
      // 直接写文件，不自动创建父目录
      // Convert data to appropriate format
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
    if (!isValidPath(path)) {
      throw new RemoteStorageError('Invalid path format');
    }
    
    try {
      // Check if file exists and is not a directory
      const stats = await this.stat(path);
      if (this.isDirectoryMode(stats.mode)) {
        throw new RemoteStorageError(`Cannot unlink directory: ${path}`);
      }

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
    if (!isValidPath(path)) {
      throw new RemoteStorageError('Invalid path format');
    }

    const dirUrl = this.buildUrl(ensureDirectoryPath(path));
    
    try {
      const response = await this.makeRequest(dirUrl, { 
        method: 'GET',
        // headers: {
        //   'Accept': 'application/ld+json',
        // },
      });
      
      if (!response.ok) {
        this.handleHttpError(response, path, 'readdir');
      }

      const contentType = response.headers.get('content-type') || '';
      
      if (contentType.includes('application/ld+json')) {
        // Parse JSON-LD directory listing
        const listing = await response.json();
        const items: string[] = [];
        
        if (listing['@graph']) {
          for (const item of listing['@graph']) {
            if (item['@id'] && item['@id'] !== './') {
              const name = item['@id'].replace(/\/$/, ''); // Remove trailing slash
              if (name) {
                items.push(name);
              }
            }
          }
        }
        
        return items;
      } else {
        // Fallback: parse HTML directory listing
        const html = await response.text();
        return this.parseHtmlDirectoryListing(html);
      }
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
    if (!isValidPath(path)) {
      throw new RemoteStorageError('Invalid path format');
    }

    try {
      // 创建占位文件，确保目录可见
      try {
        const keepFilePath = joinPath(path, '.keep');
        await this.writeFile(keepFilePath, '');
      } catch (e) {
        // 占位文件写入失败不影响主流程
      }

      // Return created directory inode
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
    if (!isValidPath(path)) {
      throw new RemoteStorageError('Invalid path format');
    }
    
    try {
      // Check if directory exists
      const stats = await this.stat(path);
      if (!this.isDirectoryMode(stats.mode)) {
        throw new RemoteStorageError(`Not a directory: ${path}`);
      }

      // Check if directory is empty
      const entries = await this.readdir(path);
      if (entries.length > 0) {
        throw new RemoteStorageError(`Directory not empty: ${path}`);
      }

      // Remove the directory itself
      const dirUrl = this.buildUrl(ensureDirectoryPath(path));
      const response = await this.makeRequest(dirUrl, { method: 'DELETE' });
      
      if (!response.ok) {
        this.handleHttpError(response, path, 'rmdir');
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
        // 文件重命名：读内容，写新路径，删旧路径
        const content = await this.readFile(oldPath);
        await this.writeFile(newPath, content);
        await this.unlink(oldPath);
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

    const url = this.buildUrl(path);
    
    try {
      // Try HEAD request to get metadata
      const response = await this.makeRequest(url, { method: 'HEAD' });
      
      if (!response.ok) {
        this.handleHttpError(response, path, 'stat');
      }

      const contentType = response.headers.get('content-type') || '';
      const contentLength = response.headers.get('content-length');
      const lastModified = response.headers.get('last-modified');

      // Check if it's a directory by trying to list it
      const isDirectory = await this.isDirectory(path);
      
      const size = contentLength ? parseInt(contentLength, 10) : 0;
      const mtime = lastModified ? new Date(lastModified).getTime() : Date.now();
      
      return {
        ino: 0,
        mode: isDirectory ? 0o040755 : 0o100644,
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
