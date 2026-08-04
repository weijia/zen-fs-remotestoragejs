/**
 * Tests for Snapshot (ETag baseline) and Precise mtime (.mtime sidecar) features.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemoteStorageFileSystem } from '../src/RemoteStorageFileSystem.js';
import { RemoteStorageConfig } from '../src/types.js';
import { mtimePathFor, isMtimeSidecar } from '../src/utils.js';

global.fetch = vi.fn();

describe('Snapshot (shouldSync)', () => {
  const mockFetch = global.fetch as any;
  let fs: RemoteStorageFileSystem;

  const baseUrl = 'https://storage.example.com/user';
  const config: RemoteStorageConfig = {
    href: baseUrl,
    token: 'test-token',
    basePath: '/app_data/',
    preciseMtime: false, // disable sidecar for snapshot-only tests
  };

  beforeEach(() => {
    mockFetch.mockReset();
    fs = new RemoteStorageFileSystem(config);
  });

  function mockRootListing(items: { name: string; etag?: string; isDir: boolean }[]) {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method || 'GET';

      // Root folder HEAD → return ETag
      if (url === baseUrl + '/app_data/' && method === 'HEAD') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([['ETag', 'root-etag-v1']]),
        });
      }

      // Root folder GET → return listing
      if (url === baseUrl + '/app_data/' && method === 'GET') {
        const graph = items.map((item) => ({
          '@id': item.isDir ? item.name + '/' : item.name,
          ETag: item.etag || 'etag-' + item.name,
        }));
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([
            ['content-type', 'application/ld+json'],
            ['ETag', 'root-etag-v1'],
          ]),
          json: () => Promise.resolve({ '@graph': graph }),
        });
      }

      return Promise.resolve({ ok: false, status: 404, headers: new Map() });
    });
  }

  it('first shouldSync() returns true and builds baseline', async () => {
    mockRootListing([
      { name: 'config.json', etag: 'etag-config-1', isDir: false },
      { name: 'data', etag: 'etag-data-1', isDir: true },
    ]);

    const result = await fs.shouldSync();
    expect(result).toBe(true);
  });

  it('second shouldSync() returns false when root ETag unchanged', async () => {
    mockRootListing([
      { name: 'config.json', etag: 'etag-config-1', isDir: false },
    ]);

    // First call builds baseline
    await fs.shouldSync();

    // Second call: HEAD root → same ETag → false
    const result = await fs.shouldSync();
    expect(result).toBe(false);
  });

  it('shouldSync() returns true when root ETag changes', async () => {
    mockRootListing([
      { name: 'config.json', etag: 'etag-config-1', isDir: false },
    ]);

    // First call builds baseline
    await fs.shouldSync();

    // Change root ETag for subsequent calls
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method || 'GET';
      if (url === baseUrl + '/app_data/' && method === 'HEAD') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([['ETag', 'root-etag-v2']]),
        });
      }
      if (url === baseUrl + '/app_data/' && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([
            ['content-type', 'application/ld+json'],
            ['ETag', 'root-etag-v2'],
          ]),
          json: () => Promise.resolve({
            '@graph': [
              { '@id': 'config.json', ETag: 'etag-config-2' },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, headers: new Map() });
    });

    const result = await fs.shouldSync();
    expect(result).toBe(true);
  });
});

describe('Precise mtime (.mtime sidecar)', () => {
  const mockFetch = global.fetch as any;
  let fs: RemoteStorageFileSystem;

  const baseUrl = 'https://storage.example.com/user';
  const config: RemoteStorageConfig = {
    href: baseUrl,
    token: 'test-token',
    basePath: '/app_data/',
    preciseMtime: true,
  };

  beforeEach(() => {
    mockFetch.mockReset();
    fs = new RemoteStorageFileSystem(config);
  });

  it('writeFile writes .mtime sidecar', async () => {
    const capturedUrls: string[] = [];
    mockFetch.mockImplementation((url: string) => {
      capturedUrls.push(url);
      return Promise.resolve({ ok: true, status: 200, headers: new Map() });
    });

    await fs.writeFile('/test.json', '{"key":"value"}');

    // Should have written both the file and the sidecar
    expect(capturedUrls).toContain(baseUrl + '/app_data/test.json');
    expect(capturedUrls).toContain(baseUrl + '/app_data/.test.json.mtime');
  });

  it('writeFile does NOT write sidecar when preciseMtime is disabled', async () => {
    const noSidecarFs = new RemoteStorageFileSystem({
      ...config,
      preciseMtime: false,
    });

    const capturedUrls: string[] = [];
    mockFetch.mockImplementation((url: string) => {
      capturedUrls.push(url);
      return Promise.resolve({ ok: true, status: 200, headers: new Map() });
    });

    await noSidecarFs.writeFile('/test.json', '{"key":"value"}');

    expect(capturedUrls).toContain(baseUrl + '/app_data/test.json');
    expect(capturedUrls).not.toContain(baseUrl + '/app_data/.test.json.mtime');
  });

  it('stat returns precise mtime from sidecar', async () => {
    const preciseMtime = 1700000000123;

    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method || 'GET';

      // HEAD for file
      if (url === baseUrl + '/app_data/test.json' && method === 'HEAD') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([
            ['content-type', 'application/octet-stream'],
            ['content-length', '15'],
            ['last-modified', 'Wed, 15 Nov 2023 12:00:00 GMT'],
          ]),
        });
      }

      // GET for .mtime sidecar
      if (url === baseUrl + '/app_data/.test.json.mtime' && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map(),
          text: () => Promise.resolve(JSON.stringify({ mtime: preciseMtime })),
        });
      }

      return Promise.resolve({ ok: false, status: 404, headers: new Map() });
    });

    const result = await fs.stat('/test.json');
    expect(result.mtimeMs).toBe(preciseMtime);
  });

  it('stat falls back to server Last-Modified when sidecar missing', async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method || 'GET';

      if (url === baseUrl + '/app_data/test.json' && method === 'HEAD') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([
            ['content-type', 'application/octet-stream'],
            ['content-length', '15'],
            ['last-modified', 'Wed, 15 Nov 2023 12:00:00 GMT'],
          ]),
        });
      }

      // Sidecar not found
      if (url === baseUrl + '/app_data/.test.json.mtime' && method === 'GET') {
        return Promise.resolve({ ok: false, status: 404, headers: new Map() });
      }

      return Promise.resolve({ ok: false, status: 404, headers: new Map() });
    });

    const result = await fs.stat('/test.json');
    // Should use server's Last-Modified (second precision)
    const expectedMtime = new Date('Wed, 15 Nov 2023 12:00:00 GMT').getTime();
    expect(result.mtimeMs).toBe(expectedMtime);
  });

  it('readdir filters out .mtime sidecar files', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === baseUrl + '/app_data/') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'application/ld+json']]),
          json: () => Promise.resolve({
            '@graph': [
              { '@id': 'config.json' },
              { '@id': '.config.json.mtime' },
              { '@id': 'data.json' },
              { '@id': '.data.json.mtime' },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, headers: new Map() });
    });

    const entries = await fs.readdir('/');
    expect(entries).toContain('config.json');
    expect(entries).toContain('data.json');
    expect(entries).not.toContain('.config.json.mtime');
    expect(entries).not.toContain('.data.json.mtime');
  });

  it('unlink deletes .mtime sidecar', async () => {
    const deletedUrls: string[] = [];
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletedUrls.push(url);
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Map() });
    });

    await fs.unlink('/test.json');

    expect(deletedUrls).toContain(baseUrl + '/app_data/test.json');
    expect(deletedUrls).toContain(baseUrl + '/app_data/.test.json.mtime');
  });

  it('touch writes mtime sidecar when preciseMtime is enabled', async () => {
    const putUrls: string[] = [];
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        putUrls.push(url);
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Map() });
    });

    await fs.touch('/test.json', { mtimeMs: 1700000000123 });

    expect(putUrls).toContain(baseUrl + '/app_data/.test.json.mtime');
  });

  it('touch is no-op when preciseMtime is disabled', async () => {
    const noSidecarFs = new RemoteStorageFileSystem({
      ...config,
      preciseMtime: false,
    });

    const fetchCalled = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, headers: new Map() })
    );
    mockFetch.mockImplementation(fetchCalled);

    await noSidecarFs.touch('/test.json', { mtimeMs: 1700000000123 });

    expect(fetchCalled).not.toHaveBeenCalled();
  });

  it('readFileMeta includes preciseMtime field', async () => {
    const preciseMtime = 1700000000123;

    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method || 'GET';

      // File GET
      if (url === baseUrl + '/app_data/test.json' && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([
            ['ETag', 'etag-1'],
            ['Last-Modified', 'Wed, 15 Nov 2023 12:00:00 GMT'],
            ['Content-Type', 'application/octet-stream'],
          ]),
          arrayBuffer: () =>
            Promise.resolve(new TextEncoder().encode('test').buffer),
        });
      }

      // Sidecar GET
      if (url === baseUrl + '/app_data/.test.json.mtime' && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map(),
          text: () => Promise.resolve(JSON.stringify({ mtime: preciseMtime })),
        });
      }

      return Promise.resolve({ ok: false, status: 404, headers: new Map() });
    });

    const meta = await fs.readFileMeta('/test.json');
    expect(meta.status).toBe(200);
    expect(meta.preciseMtime).toBe(preciseMtime);
  });
});

describe('Utility functions', () => {
  it('mtimePathFor computes correct sidecar path', () => {
    expect(mtimePathFor('foo/bar.json')).toBe('foo/.bar.json.mtime');
    expect(mtimePathFor('config.json')).toBe('.config.json.mtime');
    expect(mtimePathFor('/deep/nested/file.txt')).toBe('/deep/nested/.file.txt.mtime');
  });

  it('isMtimeSidecar detects sidecar files', () => {
    expect(isMtimeSidecar('.config.json.mtime')).toBe(true);
    expect(isMtimeSidecar('.file.txt.mtime')).toBe(true);
    expect(isMtimeSidecar('config.json')).toBe(false);
    expect(isMtimeSidecar('.keep')).toBe(false);
    expect(isMtimeSidecar('.gitignore')).toBe(false);
  });
});
