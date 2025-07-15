/**
 * Unit tests for RemoteStorageFileSystem
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemoteStorageFileSystem } from '../src/RemoteStorageFileSystem.js';
import { RemoteStorageConfig } from '../src/types.js';

// Mock fetch globally
global.fetch = vi.fn();

describe('RemoteStorageFileSystem', () => {
  const mockFetch = global.fetch as any;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('Constructor', () => {
    it('should create a RemoteStorageFileSystem instance', () => {
      const config: RemoteStorageConfig = {
        href: 'https://example.com/storage',
        token: 'test-token',
        basePath: '/public',
      };

      const fs = new RemoteStorageFileSystem(config);
      expect(fs).toBeInstanceOf(RemoteStorageFileSystem);
      expect(fs.metadata().name).toBe('RemoteStorageFileSystem');
    });

    it('should normalize base URL', () => {
      const config: RemoteStorageConfig = {
        href: 'https://example.com/storage/',
        token: 'test-token',
        basePath: '/public',
      };

      const fs = new RemoteStorageFileSystem(config);
      expect(fs).toBeInstanceOf(RemoteStorageFileSystem);
    });
  });

  describe('Sync Methods', () => {
    it('should throw errors for unsupported sync operations', () => {
      const config: RemoteStorageConfig = {
        href: 'https://example.com/storage',
        token: 'test-token',
        basePath: '/public',
      };

      const fs = new RemoteStorageFileSystem(config);
      
      expect(() => fs.statSync()).toThrow('Synchronous operations not supported');
      expect(() => fs.readFileSync()).toThrow('Synchronous operations not supported');
      expect(() => fs.writeFileSync()).toThrow('Synchronous operations not supported');
      expect(() => fs.readdirSync()).toThrow('Synchronous operations not supported');
      expect(() => fs.unlinkSync()).toThrow('Synchronous operations not supported');
      expect(() => fs.mkdirSync()).toThrow('Synchronous operations not supported');
      expect(() => fs.rmdirSync()).toThrow('Synchronous operations not supported');
      expect(() => fs.renameSync()).toThrow('Synchronous operations not supported');
    });
  });

  describe('Async Methods', () => {
    let fs: RemoteStorageFileSystem;

    beforeEach(() => {
      const config: RemoteStorageConfig = {
        href: 'https://example.com/storage',
        token: 'test-token',
        basePath: '/public',
      };
      fs = new RemoteStorageFileSystem(config);
    });

    it('should handle disconnect gracefully', async () => {
      await expect(fs.disconnect()).resolves.toBeUndefined();
    });

    it('should handle sync gracefully', async () => {
      await expect(fs.sync()).resolves.toBeUndefined();
    });

    it('should return proper metadata', () => {
      const metadata = fs.metadata();
      expect(metadata.name).toBe('RemoteStorageFileSystem');
      expect(metadata.readonly).toBe(false);
    });
  });
});
