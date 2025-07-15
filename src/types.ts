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
