/**
 * Utility functions for RemoteStorage filesystem
 */

/**
 * Normalize a path by removing leading/trailing slashes and handling relative paths
 */
export function normalizePath(path: string): string {
  if (!path || path === '/') {
    return '';
  }
  
  // Remove leading slash
  if (path.startsWith('/')) {
    path = path.slice(1);
  }
  
  // Remove trailing slash unless it's the root
  if (path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  // }
  
  return path;
}

/**
 * Get the parent directory path
 */
export function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) {
    return '';
  }
  
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) {
    return '';
  }
  
  return normalized.slice(0, lastSlash);
}

/**
 * Get the basename of a path
 */
export function getBasename(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) {
    return '';
  }
  
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) {
    return normalized;
  }
  
  return normalized.slice(lastSlash + 1);
}

/**
 * Check if a path represents a directory (ends with '/')
 */
export function isDirectoryPath(path: string): boolean {
  return path.endsWith('/');
}

/**
 * Ensure a path ends with '/' for directory operations
 */
export function ensureDirectoryPath(path: string): string {
  if (!path) {
    return '/';
  }
  return path.endsWith('/') ? path : path + '/';
}

/**
 * Convert ArrayBuffer to Uint8Array
 */
export function arrayBufferToUint8Array(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

/**
 * Convert string to Uint8Array
 */
export function stringToUint8Array(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Convert Uint8Array to string
 */
export function uint8ArrayToString(arr: Uint8Array): string {
  return new TextDecoder().decode(arr);
}

/**
 * Convert various data types to Uint8Array
 */
export function toUint8Array(data: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof data === 'string') {
    return stringToUint8Array(data);
  } else if (data instanceof ArrayBuffer) {
    return arrayBufferToUint8Array(data);
  } else if (data instanceof Uint8Array) {
    return data;
  } else {
    throw new Error('Unsupported data type');
  }
}

/**
 * Parse content type and determine if it's binary
 */
export function isBinaryContentType(contentType?: string): boolean {
  if (!contentType) {
    return false;
  }
  
  const textTypes = [
    'text/',
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-javascript',
    'application/typescript',
  ];
  
  return !textTypes.some(type => contentType.startsWith(type));
}

/**
 * Generate a simple timestamp
 */
export function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Validate path format
 */
export function isValidPath(path: string): boolean {
  if (typeof path !== 'string') {
    return false;
  }
  
  // Check for invalid characters
  const invalidChars = /[<>:"|?*\x00-\x1f]/;
  if (invalidChars.test(path)) {
    return false;
  }
  
  return true;
}

/**
 * Join path segments
 */
export function joinPath(...segments: string[]): string {
  const joined = segments
    .filter(segment => segment && segment.length > 0)
    .map(segment => segment.replace(/^\/+|\/+$/g, ''))
    .join('/');
  
  return joined || '';
}

// ---------------------------------------------------------------------------
// mtime Sidecar Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the .mtime sidecar path for a given file path.
 *
 * /documents/note.json → /documents/.note.json.mtime
 * /config.json         → /.config.json.mtime
 */
export function mtimePathFor(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const mtimeFileName = `.${fileName}.mtime`;
  return dir ? `${dir}/${mtimeFileName}` : mtimeFileName;
}

/**
 * Check whether a filename is a .mtime sidecar file.
 *
 * .note.json.mtime → true
 * note.json        → false
 */
export function isMtimeSidecar(name: string): boolean {
  return name.startsWith('.') && name.endsWith('.mtime');
}
