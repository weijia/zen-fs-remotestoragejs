/**
 * Unit tests for utility functions
 */

import { describe, it, expect } from 'vitest';
import {
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
  isValidPath,
  joinPath,
} from '../src/utils.js';

describe('Utility Functions', () => {
  describe('normalizePath', () => {
    it('should normalize various path formats', () => {
      expect(normalizePath('/')).toBe('');
      expect(normalizePath('/path')).toBe('path');
      expect(normalizePath('path/')).toBe('path');
      expect(normalizePath('/path/')).toBe('path');
      expect(normalizePath('path/to/file')).toBe('path/to/file');
      expect(normalizePath('/path/to/file/')).toBe('path/to/file');
    });

    it('should handle empty and invalid paths', () => {
      expect(normalizePath('')).toBe('');
      expect(normalizePath('/')).toBe('');
    });
  });

  describe('getParentPath', () => {
    it('should return parent directory path', () => {
      expect(getParentPath('file.txt')).toBe('');
      expect(getParentPath('folder/file.txt')).toBe('folder');
      expect(getParentPath('deep/nested/folder/file.txt')).toBe('deep/nested/folder');
      expect(getParentPath('/absolute/path/file.txt')).toBe('absolute/path');
    });

    it('should handle root and empty paths', () => {
      expect(getParentPath('')).toBe('');
      expect(getParentPath('/')).toBe('');
      expect(getParentPath('root')).toBe('');
    });
  });

  describe('getBasename', () => {
    it('should return filename from path', () => {
      expect(getBasename('file.txt')).toBe('file.txt');
      expect(getBasename('folder/file.txt')).toBe('file.txt');
      expect(getBasename('deep/nested/folder/file.txt')).toBe('file.txt');
      expect(getBasename('/absolute/path/file.txt')).toBe('file.txt');
    });

    it('should handle directory names', () => {
      expect(getBasename('folder')).toBe('folder');
      expect(getBasename('path/to/folder')).toBe('folder');
    });

    it('should handle empty paths', () => {
      expect(getBasename('')).toBe('');
      expect(getBasename('/')).toBe('');
    });
  });

  describe('isDirectoryPath', () => {
    it('should identify directory paths', () => {
      expect(isDirectoryPath('folder/')).toBe(true);
      expect(isDirectoryPath('/path/to/folder/')).toBe(true);
      expect(isDirectoryPath('/')).toBe(true);
    });

    it('should identify file paths', () => {
      expect(isDirectoryPath('file.txt')).toBe(false);
      expect(isDirectoryPath('folder/file.txt')).toBe(false);
      expect(isDirectoryPath('/path/to/file.txt')).toBe(false);
      expect(isDirectoryPath('')).toBe(false);
    });
  });

  describe('ensureDirectoryPath', () => {
    it('should ensure path ends with slash', () => {
      expect(ensureDirectoryPath('folder')).toBe('folder/');
      expect(ensureDirectoryPath('folder/')).toBe('folder/');
      expect(ensureDirectoryPath('path/to/folder')).toBe('path/to/folder/');
      expect(ensureDirectoryPath('path/to/folder/')).toBe('path/to/folder/');
    });

    it('should handle empty path', () => {
      expect(ensureDirectoryPath('')).toBe('/');
    });
  });

  describe('data conversion functions', () => {
    describe('arrayBufferToUint8Array', () => {
      it('should convert ArrayBuffer to Uint8Array', () => {
        const buffer = new ArrayBuffer(4);
        const view = new DataView(buffer);
        view.setUint8(0, 1);
        view.setUint8(1, 2);
        view.setUint8(2, 3);
        view.setUint8(3, 4);

        const result = arrayBufferToUint8Array(buffer);
        
        expect(result).toBeInstanceOf(Uint8Array);
        expect(result.length).toBe(4);
        expect(Array.from(result)).toEqual([1, 2, 3, 4]);
      });
    });

    describe('stringToUint8Array', () => {
      it('should convert string to Uint8Array', () => {
        const result = stringToUint8Array('hello');
        
        expect(result).toBeInstanceOf(Uint8Array);
        expect(result.length).toBe(5);
        expect(uint8ArrayToString(result)).toBe('hello');
      });

      it('should handle Unicode characters', () => {
        const result = stringToUint8Array('你好');
        
        expect(result).toBeInstanceOf(Uint8Array);
        expect(uint8ArrayToString(result)).toBe('你好');
      });
    });

    describe('uint8ArrayToString', () => {
      it('should convert Uint8Array to string', () => {
        const arr = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
        const result = uint8ArrayToString(arr);
        
        expect(result).toBe('hello');
      });
    });

    describe('toUint8Array', () => {
      it('should convert string to Uint8Array', () => {
        const result = toUint8Array('hello');
        
        expect(result).toBeInstanceOf(Uint8Array);
        expect(uint8ArrayToString(result)).toBe('hello');
      });

      it('should convert ArrayBuffer to Uint8Array', () => {
        const buffer = new ArrayBuffer(4);
        const result = toUint8Array(buffer);
        
        expect(result).toBeInstanceOf(Uint8Array);
        expect(result.byteLength).toBe(4);
      });

      it('should pass through Uint8Array unchanged', () => {
        const arr = new Uint8Array([1, 2, 3]);
        const result = toUint8Array(arr);
        
        expect(result).toBe(arr);
      });

      it('should throw error for unsupported types', () => {
        expect(() => toUint8Array(123 as any)).toThrow('Unsupported data type');
        expect(() => toUint8Array({} as any)).toThrow('Unsupported data type');
      });
    });
  });

  describe('isBinaryContentType', () => {
    it('should identify text content types', () => {
      expect(isBinaryContentType('text/plain')).toBe(false);
      expect(isBinaryContentType('text/html')).toBe(false);
      expect(isBinaryContentType('application/json')).toBe(false);
      expect(isBinaryContentType('application/xml')).toBe(false);
      expect(isBinaryContentType('application/javascript')).toBe(false);
      expect(isBinaryContentType('application/x-javascript')).toBe(false);
      expect(isBinaryContentType('application/typescript')).toBe(false);
    });

    it('should identify binary content types', () => {
      expect(isBinaryContentType('image/png')).toBe(true);
      expect(isBinaryContentType('image/jpeg')).toBe(true);
      expect(isBinaryContentType('application/octet-stream')).toBe(true);
      expect(isBinaryContentType('video/mp4')).toBe(true);
      expect(isBinaryContentType('audio/mp3')).toBe(true);
    });

    it('should handle undefined content type', () => {
      expect(isBinaryContentType(undefined)).toBe(false);
      expect(isBinaryContentType('')).toBe(false);
    });
  });

  describe('isValidPath', () => {
    it('should validate correct paths', () => {
      expect(isValidPath('file.txt')).toBe(true);
      expect(isValidPath('folder/file.txt')).toBe(true);
      expect(isValidPath('/absolute/path/file.txt')).toBe(true);
      expect(isValidPath('path with spaces.txt')).toBe(true);
      expect(isValidPath('path.with.dots/file.txt')).toBe(true);
    });

    it('should reject invalid paths', () => {
      expect(isValidPath('file<.txt')).toBe(false);
      expect(isValidPath('file>.txt')).toBe(false);
      expect(isValidPath('file:.txt')).toBe(false);
      expect(isValidPath('file".txt')).toBe(false);
      expect(isValidPath('file|.txt')).toBe(false);
      expect(isValidPath('file?.txt')).toBe(false);
      expect(isValidPath('file*.txt')).toBe(false);
      expect(isValidPath('file\x00.txt')).toBe(false);
    });

    it('should reject non-string values', () => {
      expect(isValidPath(123 as any)).toBe(false);
      expect(isValidPath({} as any)).toBe(false);
      expect(isValidPath(null as any)).toBe(false);
      expect(isValidPath(undefined as any)).toBe(false);
    });
  });

  describe('joinPath', () => {
    it('should join path segments correctly', () => {
      expect(joinPath('folder', 'file.txt')).toBe('folder/file.txt');
      expect(joinPath('path', 'to', 'file.txt')).toBe('path/to/file.txt');
      expect(joinPath('/root', 'folder', 'file.txt')).toBe('root/folder/file.txt');
    });

    it('should handle trailing and leading slashes', () => {
      expect(joinPath('folder/', 'file.txt')).toBe('folder/file.txt');
      expect(joinPath('folder', '/file.txt')).toBe('folder/file.txt');
      expect(joinPath('folder/', '/file.txt')).toBe('folder/file.txt');
    });

    it('should filter empty segments', () => {
      expect(joinPath('', 'folder', '', 'file.txt', '')).toBe('folder/file.txt');
      expect(joinPath('folder', '', 'file.txt')).toBe('folder/file.txt');
    });

    it('should handle single segment', () => {
      expect(joinPath('file.txt')).toBe('file.txt');
      expect(joinPath('')).toBe('');
    });

    it('should return empty string for all empty segments', () => {
      expect(joinPath('', '', '')).toBe('');
      expect(joinPath()).toBe('');
    });
  });
});
