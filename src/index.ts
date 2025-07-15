/**
 * zen-fs backend for RemoteStorage.js
 * 
 * This package provides a zen-fs backend implementation that uses RemoteStorage.js
 * for distributed file storage across various cloud providers.
 */

export { RemoteStorageFileSystem } from './RemoteStorageFileSystem.js';
export type {
  RemoteStorageConfig,
  RemoteStorageStat,
  RemoteStorageEntry,
} from './types.js';
export {
  RemoteStorageError,
  FileNotFoundError,
  DirectoryNotFoundError,
  FileExistsError,
  AuthenticationError,
  PermissionDeniedError,
} from './types.js';
export {
  normalizePath,
  getParentPath,
  getBasename,
  isDirectoryPath,
  ensureDirectoryPath,
  arrayBufferToUint8Array,
  stringToUint8Array,
  uint8ArrayToString,
  toUint8Array,
  isBinaryContentType,
  getCurrentTimestamp,
  isValidPath,
  joinPath,
} from './utils.js';

import { RemoteStorageFileSystem } from './RemoteStorageFileSystem.js';
import type { RemoteStorageConfig } from './types.js';

/**
 * Create a new RemoteStorage filesystem instance
 */
export function createRemoteStorageFileSystem(config: RemoteStorageConfig) {
  return new RemoteStorageFileSystem(config);
}

// Default export for convenience
export default RemoteStorageFileSystem;
