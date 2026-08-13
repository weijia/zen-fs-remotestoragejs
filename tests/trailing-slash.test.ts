/**
 * Comprehensive tests for trailing slash handling in RemoteStorageFileSystem.
 *
 * RemoteStorage requires directory URLs to end with '/' and file URLs
 * to NOT end with '/'. These tests verify that every public method
 * produces the correct URL regardless of whether the caller passes
 * a trailing slash.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemoteStorageFileSystem } from '../src/RemoteStorageFileSystem.js';
import { RemoteStorageConfig } from '../src/types.js';

global.fetch = vi.fn();

describe('Trailing slash handling', () => {
  const mockFetch = global.fetch as any;
  let fs: RemoteStorageFileSystem;

  const baseUrl = 'https://storage.5apps.com/weijia';
  const config: RemoteStorageConfig = {
    href: baseUrl,
    token: 'test-token',
    basePath: '/app_data/configs/',
    persistCache: false,
  };

  beforeEach(() => {
    mockFetch.mockReset();
    fs = new RemoteStorageFileSystem(config);
  });

  // Helper: extract the URL from the last fetch call
  function lastFetchUrl(): string {
    const calls = mockFetch.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][0];
  }

  // Helper: setup fetch responses for common patterns
  function setupDirectoryResponse(path: string, items: string[] = []) {
    mockFetch.mockImplementation((url: string) => {
      // Root directory listing — must include the target path as a directory entry
      // so ensureDirListing's parent verification passes.
      if (url === baseUrl + '/app_data/configs/') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'application/ld+json']]),
          json: () => Promise.resolve({
            '@graph': [{ '@id': path + '/' }],
          }),
        });
      }
      if (url.endsWith(path + '/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'application/ld+json']]),
          json: () => Promise.resolve({
            '@graph': items.map((name) => ({ '@id': name + '/' })),
          }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        headers: new Map(),
      });
    });
  }

  function setupFileResponse(path: string, content = 'test') {
    mockFetch.mockImplementation((url: string) => {
      if (url === baseUrl + '/app_data/configs/' + path) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([
            ['content-type', 'application/octet-stream'],
            ['content-length', String(content.length)],
          ]),
          arrayBuffer: () => Promise.resolve(new TextEncoder().encode(content).buffer),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        headers: new Map(),
      });
    });
  }

  // ========================================================================
  // buildUrl (via private method - tested indirectly through public methods)
  // ========================================================================

  describe('buildUrl directory detection', () => {
    it('readdir adds trailing slash for directory URLs', async () => {
      setupDirectoryResponse('.meta', ['backends.json']);
      await fs.readdir('/.meta');
      expect(lastFetchUrl()).toBe(baseUrl + '/app_data/configs/.meta/');
    });

    it('readdir keeps trailing slash when caller passes it', async () => {
      setupDirectoryResponse('.meta', ['backends.json']);
      await fs.readdir('/.meta/');
      expect(lastFetchUrl()).toBe(baseUrl + '/app_data/configs/.meta/');
    });

    it('readFile does NOT add trailing slash for file URLs', async () => {
      setupFileResponse('.meta/backends.json', '{"version":1}');
      await fs.readFile('/.meta/backends.json');
      expect(lastFetchUrl()).toBe(baseUrl + '/app_data/configs/.meta/backends.json');
    });

    it('writeFile does NOT add trailing slash for file URLs', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
      });
      await fs.writeFile('/.meta/backends.json', '{"version":1}');
      // writeFile now also writes a .mtime sidecar; check the main file PUT URL
      const calls = mockFetch.mock.calls.map((c: any[]) => c[0]);
      expect(calls).toContain(baseUrl + '/app_data/configs/.meta/backends.json');
    });
  });

  // ========================================================================
  // stat (uses readdir internally for directory detection)
  // ========================================================================

  describe('stat with directory paths', () => {
    it('stat("/.meta") detects directory via readdir (no trailing slash from caller)', async () => {
      // readdir is called first inside stat
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/.meta/')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/ld+json']]),
            json: () => Promise.resolve({ '@graph': [{ '@id': 'backends.json' }] }),
          });
        }
        return Promise.resolve({ ok: false, status: 404, headers: new Map() });
      });

      const result = await fs.stat('/.meta');
      expect(result.mode).toBe(0o040755); // directory mode
    });

    it('stat("/.meta/") also detects directory', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/.meta/')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/ld+json']]),
            json: () => Promise.resolve({ '@graph': [{ '@id': 'backends.json' }] }),
          });
        }
        return Promise.resolve({ ok: false, status: 404, headers: new Map() });
      });

      const result = await fs.stat('/.meta/');
      expect(result.mode).toBe(0o040755);
    });

    it('stat("/my-app/config.json") detects file via HEAD', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === baseUrl + '/app_data/configs/my-app/config.json') {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map([
              ['content-type', 'application/octet-stream'],
              ['content-length', '42'],
            ]),
          });
        }
        // readdir fails → not a directory
        if (url.endsWith('/my-app/config.json/')) {
          return Promise.resolve({ ok: false, status: 404, headers: new Map() });
        }
        return Promise.resolve({ ok: false, status: 404, headers: new Map() });
      });

      const result = await fs.stat('/my-app/config.json');
      expect(result.mode).toBe(0o100644); // file mode
    });
  });

  // ========================================================================
  // mkdir
  // ========================================================================

  describe('mkdir', () => {
    it('creates directory with trailing slash URL', async () => {
      mockFetch.mockImplementation((url: string) => {
        // PUT to the .keep file inside the new directory
        if (url.endsWith('/new-dir/.keep')) {
          return Promise.resolve({ ok: true, status: 200, headers: new Map() });
        }
        return Promise.resolve({ ok: false, status: 404, headers: new Map() });
      });

      await fs.mkdir('/new-dir', { recursive: true } as any);
      // mkdir calls writeFile('.keep') which also writes a .mtime sidecar;
      // check that the .keep file PUT URL (without trailing slash) was called
      const calls = mockFetch.mock.calls.map((c: any[]) => c[0]);
      expect(calls).toContain(baseUrl + '/app_data/configs/new-dir/.keep');
    });
  });

  // ========================================================================
  // rmdir
  // ========================================================================

  describe('rmdir', () => {
    it('reads directory with trailing slash then deletes .keep', async () => {
      mockFetch.mockImplementation((url: string) => {
        // Root listing must include empty-dir as a directory entry
        if (url === baseUrl + '/app_data/configs/') {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/ld+json']]),
            json: () => Promise.resolve({ '@graph': [{ '@id': 'empty-dir/' }] }),
          });
        }
        if (url.endsWith('/empty-dir/')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/ld+json']]),
            json: () => Promise.resolve({ '@graph': [{ '@id': '.keep/' }] }),
          });
        }
        if (url.endsWith('/empty-dir/.keep')) {
          return Promise.resolve({ ok: true, status: 200, headers: new Map() });
        }
        return Promise.resolve({ ok: false, status: 404, headers: new Map() });
      });

      await fs.rmdir('/empty-dir');
      // Should call readdir first (trailing slash), then unlink .keep (no trailing slash)
      const calls = mockFetch.mock.calls.map((c: any[]) => c[0]);
      expect(calls).toContain(baseUrl + '/app_data/configs/empty-dir/');
      expect(calls).toContain(baseUrl + '/app_data/configs/empty-dir/.keep');
    });
  });

  // ========================================================================
  // exists
  // ========================================================================

  describe('exists', () => {
    it('exists("/.meta") returns true for directory', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/.meta/')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/ld+json']]),
            json: () => Promise.resolve({ '@graph': [] }),
          });
        }
        return Promise.resolve({ ok: false, status: 404, headers: new Map() });
      });

      expect(await fs.exists('/.meta')).toBe(true);
    });

    it('exists("/nonexistent") returns false', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, headers: new Map() });
      expect(await fs.exists('/nonexistent')).toBe(false);
    });
  });

  // ========================================================================
  // rename (file)
  // ========================================================================

  describe('rename', () => {
    it('rename file uses file URLs without trailing slash', async () => {
      mockFetch.mockImplementation((url: string, init?: RequestInit) => {
        // old.txt — used by HEAD (stat), GET (readFile), DELETE (unlink)
        if (url === baseUrl + '/app_data/configs/old.txt') {
          const method = init?.method || 'GET';
          if (method === 'DELETE') {
            return Promise.resolve({ ok: true, status: 200, headers: new Map() });
          }
          return Promise.resolve({
            ok: true, status: 200,
            headers: new Map([['content-type', 'text/plain'], ['content-length', '5']]),
            arrayBuffer: () => Promise.resolve(new TextEncoder().encode('hello').buffer),
          });
        }
        // new.txt — used by HEAD (exists) and PUT (writeFile)
        if (url === baseUrl + '/app_data/configs/new.txt') {
          const method = init?.method || 'GET';
          if (method === 'PUT') {
            return Promise.resolve({ ok: true, status: 200, headers: new Map() });
          }
          return Promise.resolve({ ok: false, status: 404, headers: new Map() });
        }
        return Promise.resolve({ ok: false, status: 404, headers: new Map() });
      });

      await fs.rename('/old.txt', '/new.txt');
      const calls = mockFetch.mock.calls.map((c: any[]) => `${c[1]?.method || 'GET'} ${c[0]}`);
      console.log('rename calls:', calls);
      // File read/write/delete URLs must not have trailing slash.
      // (HEAD/GET probes from stat() may use directory URLs — that's expected.)
      const fileOps = calls.filter((c: string) =>
        c.startsWith('GET ') && !c.endsWith('/')
        || c.startsWith('PUT ')
        || c.startsWith('DELETE ')
      );
      fileOps.forEach((call: string) => {
        const url = call.split(' ')[1];
        expect(url).not.toMatch(/\.txt\/$/);
      });
    });
  });

  // ========================================================================
  // Edge cases
  // ========================================================================

  describe('edge cases', () => {
    it('root path "//" is normalized to root directory URL', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === baseUrl + '/app_data/configs/') {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/ld+json']]),
            json: () => Promise.resolve({ '@graph': [] }),
          });
        }
        return Promise.resolve({ ok: false, status: 404, headers: new Map() });
      });

      await fs.readdir('//');
      expect(lastFetchUrl()).toBe(baseUrl + '/app_data/configs/');
    });

    it('nested directory path gets trailing slash', async () => {
      // ensureDirListing now recursively verifies parent directories,
      // so we need to mock listings for every ancestor.
      mockFetch.mockImplementation((url: string) => {
        const dirResponse = (items: string[]) => ({
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'application/ld+json']]),
          json: () => Promise.resolve({ '@graph': items.map((name) => ({ '@id': name })) }),
        });
        if (url === baseUrl + '/app_data/configs/') return Promise.resolve(dirResponse(['deep/']));
        if (url.endsWith('/deep/')) return Promise.resolve(dirResponse(['nested/']));
        if (url.endsWith('/deep/nested/')) return Promise.resolve(dirResponse(['dir/']));
        if (url.endsWith('/deep/nested/dir/')) return Promise.resolve(dirResponse([]));
        return Promise.resolve({ ok: false, status: 404, headers: new Map() });
      });

      await fs.readdir('/deep/nested/dir');
      expect(lastFetchUrl()).toBe(baseUrl + '/app_data/configs/deep/nested/dir/');
    });
  });
});
