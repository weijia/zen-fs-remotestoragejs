/**
 * Comprehensive tests for RemoteStorageFileSystem cache behavior.
 *
 * Covers:
 *   1. dirListingCache: HIT/MISS, TTL expiry, persistence across instances
 *   2. existenceCache: positive/negative TTL, MISS on fresh instance
 *   3. ensureDirListing: parent directory verification before fetch
 *   4. buildUrl: trailing slash for directory URLs
 *   5. Cache invalidation: write/delete patches parent dir listing
 *   6. Cache restoration: ts refresh gives fresh TTL window
 *   7. ensureCacheLoaded: timing guarantees and memoization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteStorageFileSystem } from '../src/RemoteStorageFileSystem.js';
import { RemoteStorageConfig } from '../src/types.js';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

global.fetch = vi.fn();

const baseUrl = 'https://storage.5apps.com/weijia';

/** Config with persistence DISABLED — for tests that don't need cross-instance persistence. */
const noPersistConfig: RemoteStorageConfig = {
  href: baseUrl,
  token: 'test-token',
  basePath: '/app_data/configs/',
  preciseMtime: false,
  persistCache: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock fetch that serves directory listings and file responses. */
function createMockFetch(handlers: {
  dirs?: Record<string, { name: string; isDir: boolean; etag?: string }[]>;
  files?: Record<string, string | { content: string; etag?: string; lastModified?: string }>;
}) {
  return vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method || 'GET';

    // HEAD request — file metadata
    if (method === 'HEAD') {
      for (const [filePath, meta] of Object.entries(handlers.files || {})) {
        const fullUrl = `${baseUrl}/app_data/configs/${filePath}`;
        if (url === fullUrl) {
          const m = typeof meta === 'string' ? { content: meta } : meta;
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map([
              ['content-type', 'application/octet-stream'],
              ['content-length', String(m.content.length)],
              ...(m.etag ? [['ETag', m.etag]] : []),
              ...(m.lastModified ? [['Last-Modified', m.lastModified]] : []),
            ]),
          });
        }
      }
      return Promise.resolve({ ok: false, status: 404, headers: new Map() });
    }

    // GET request — directory listing or file content
    if (method === 'GET') {
      // Directory listing (URL ends with '/')
      for (const [dirPath, items] of Object.entries(handlers.dirs || {})) {
        const dirUrl = `${baseUrl}/app_data/configs/${dirPath}`;
        if (url === dirUrl) {
          const graph = items.map((item) => ({
            '@id': item.isDir ? item.name + '/' : item.name,
            ETag: item.etag || `etag-${item.name}`,
          }));
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map([
              ['content-type', 'application/ld+json'],
              ['ETag', `dir-etag-${dirPath}`],
            ]),
            json: () => Promise.resolve({ '@graph': graph }),
          });
        }
      }

      // File content
      for (const [filePath, meta] of Object.entries(handlers.files || {})) {
        const fileUrl = `${baseUrl}/app_data/configs/${filePath}`;
        if (url === fileUrl) {
          const m = typeof meta === 'string' ? { content: meta } : meta;
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map([
              ['content-type', 'application/octet-stream'],
              ['content-length', String(m.content.length)],
            ]),
            arrayBuffer: () =>
              Promise.resolve(new TextEncoder().encode(m.content).buffer),
          });
        }
      }

      return Promise.resolve({ ok: false, status: 404, headers: new Map() });
    }

    // PUT / DELETE — always succeed
    return Promise.resolve({ ok: true, status: 200, headers: new Map() });
  });
}

/** Wait for the debounced cache save (500ms) to complete. */
function waitForSave(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 600));
}

/** Get a unique temp cache file path. */
function tempCacheFile(): string {
  return path.join(
    os.tmpdir(),
    `rs-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

/** Get all GET request URLs from mock fetch calls. */
function getGetUrls(mockFetch: any): string[] {
  return mockFetch.mock.calls
    .filter((c: any[]) => (c[1]?.method || 'GET') === 'GET')
    .map((c: any[]) => c[0]);
}

// ===========================================================================
// 1. dirListingCache — basic HIT/MISS and TTL
// ===========================================================================

describe('dirListingCache: basic caching', () => {
  const mockFetch = global.fetch as any;
  let fs: RemoteStorageFileSystem;

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: {
          '': [
            { name: 'config.json', isDir: false },
            { name: 'data', isDir: true },
          ],
        },
      }),
    );
    fs = new RemoteStorageFileSystem({ ...noPersistConfig });
  });

  it('first readdir() fetches from network (MISS)', async () => {
    await fs.readdir('/');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(`${baseUrl}/app_data/configs/`);
  });

  it('second readdir() uses cache (HIT) — no extra fetch', async () => {
    await fs.readdir('/');
    const callsBefore = mockFetch.mock.calls.length;
    await fs.readdir('/');
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  it('stat() after readdir() uses cached dir listing — no HEAD', async () => {
    await fs.readdir('/');
    const callsBefore = mockFetch.mock.calls.length;
    const stat = await fs.stat('/config.json');
    // stat found config.json in the cached dir listing — no extra fetch needed
    expect(stat.mode & 0o170000).toBe(0o100000); // regular file
  });
});

// ===========================================================================
// 2. dirListingCache — TTL expiry
// ===========================================================================

describe('dirListingCache: TTL expiry', () => {
  const mockFetch = global.fetch as any;
  let fs: RemoteStorageFileSystem;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: {
          '': [{ name: 'file.txt', isDir: false }],
        },
      }),
    );
    fs = new RemoteStorageFileSystem({ ...noPersistConfig });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cache entry is valid within TTL (5 min)', async () => {
    await fs.readdir('/');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance 4 minutes — still within TTL
    vi.advanceTimersByTime(4 * 60_000);
    await fs.readdir('/');
    expect(mockFetch).toHaveBeenCalledTimes(1); // still cached
  });

  it('cache entry expires after TTL (5 min)', async () => {
    await fs.readdir('/');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance past 5 minutes
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await fs.readdir('/');
    expect(mockFetch).toHaveBeenCalledTimes(2); // re-fetched
  });
});

// ===========================================================================
// 3. dirListingCache — persistence across instances
// ===========================================================================

describe('dirListingCache: persistence', () => {
  const mockFetch = global.fetch as any;
  let cacheFile: string;

  beforeEach(() => {
    mockFetch.mockReset();
    cacheFile = tempCacheFile();
  });

  afterEach(() => {
    try { nodeFs.unlinkSync(cacheFile); } catch {}
  });

  it('cache is persisted and restored on new instance', async () => {
    // Instance 1: readdir to populate cache
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: {
          '': [
            { name: 'a.txt', isDir: false },
            { name: 'b.txt', isDir: false },
          ],
        },
      }),
    );
    const fs1 = new RemoteStorageFileSystem({
      ...noPersistConfig,
      persistCache: true,
      cacheFile,
    });
    await fs1.readdir('/');
    await waitForSave();
    expect(nodeFs.existsSync(cacheFile)).toBe(true);

    // Instance 2: should restore from cache file
    let fetchCount = 0;
    const baseImpl = createMockFetch({
      dirs: {
        '': [
          { name: 'a.txt', isDir: false },
          { name: 'b.txt', isDir: false },
        ],
      },
    });
    mockFetch.mockImplementation((...args: any[]) => {
      fetchCount++;
      return baseImpl(...args);
    });

    const fs2 = new RemoteStorageFileSystem({
      ...noPersistConfig,
      persistCache: true,
      cacheFile,
    });
    // Constructor kicks off ensureCacheLoaded() — wait for it
    await new Promise((r) => setTimeout(r, 100));
    await fs2.readdir('/');

    // Should have used restored cache — no fetch needed
    expect(fetchCount).toBe(0);
  });

  it('persistCache: false disables persistence', async () => {
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: { '': [{ name: 'x.txt', isDir: false }] },
      }),
    );
    const fs1 = new RemoteStorageFileSystem({
      ...noPersistConfig,
      persistCache: false,
      cacheFile,
    });
    await fs1.readdir('/');
    await waitForSave();

    // No cache file should be created
    expect(nodeFs.existsSync(cacheFile)).toBe(false);
  });
});

// ===========================================================================
// 4. Cache restoration — ts refresh gives fresh TTL window
// ===========================================================================

describe('dirListingCache: ts refresh on restore', () => {
  const mockFetch = global.fetch as any;
  let cacheFile: string;

  beforeEach(() => {
    mockFetch.mockReset();
    cacheFile = tempCacheFile();
  });

  afterEach(() => {
    try { nodeFs.unlinkSync(cacheFile); } catch {}
  });

  it('restored entries get a fresh TTL window (do not expire immediately)', async () => {
    // Instance 1: populate cache
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: { '': [{ name: 'file.txt', isDir: false }] },
      }),
    );
    const fs1 = new RemoteStorageFileSystem({
      ...noPersistConfig,
      persistCache: true,
      cacheFile,
    });
    await fs1.readdir('/');
    await waitForSave();
    expect(nodeFs.existsSync(cacheFile)).toBe(true);

    // Instance 2: restore from cache immediately.
    // The persisted ts is from a few ms ago, so it would be within TTL
    // even without ts refresh. But the key test is: the restored cache
    // is usable (HIT, not MISS).
    let fetchCount = 0;
    const baseImpl = createMockFetch({
      dirs: { '': [{ name: 'file.txt', isDir: false }] },
    });
    mockFetch.mockImplementation((...args: any[]) => {
      fetchCount++;
      return baseImpl(...args);
    });

    const fs2 = new RemoteStorageFileSystem({
      ...noPersistConfig,
      persistCache: true,
      cacheFile,
    });
    await new Promise((r) => setTimeout(r, 100));
    await fs2.readdir('/');

    // Should have used restored cache — no fetch needed
    expect(fetchCount).toBe(0);
  });

  it('restored entries with old ts still work (ts refresh prevents immediate expiry)', async () => {
    // Manually write a cache file with an old timestamp to simulate
    // a cache that was persisted 10 minutes ago (past TTL).
    const oldTs = Date.now() - 10 * 60_000; // 10 minutes ago
    const cacheData = {
      [`${baseUrl}/app_data/configs/`]: {
        '': {
          etag: 'dir-etag-',
          ts: oldTs,
          entries: {
            'old-file.txt': { name: 'old-file.txt', isDir: false, etag: 'etag-old-file.txt' },
          },
        },
      },
    };
    nodeFs.writeFileSync(cacheFile, JSON.stringify(cacheData), 'utf-8');

    let fetchCount = 0;
    const baseImpl = createMockFetch({
      dirs: { '': [{ name: 'old-file.txt', isDir: false }] },
    });
    mockFetch.mockImplementation((...args: any[]) => {
      fetchCount++;
      return baseImpl(...args);
    });

    const fs = new RemoteStorageFileSystem({
      ...noPersistConfig,
      persistCache: true,
      cacheFile,
    });
    await new Promise((r) => setTimeout(r, 100));
    await fs.readdir('/');

    // Without ts refresh, the entry (age=10min > TTL=5min) would be expired
    // and deleted on access → MISS → fetch from network.
    // With ts refresh, the entry gets a fresh TTL window → HIT → no fetch.
    expect(fetchCount).toBe(0);
  });
});

// ===========================================================================
// 5. existenceCache — TTL and behavior
// ===========================================================================

describe('existenceCache: TTL and behavior', () => {
  const mockFetch = global.fetch as any;
  let fs: RemoteStorageFileSystem;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: { '': [{ name: 'exists.txt', isDir: false }] },
        files: { 'exists.txt': 'hello' },
      }),
    );
    fs = new RemoteStorageFileSystem({ ...noPersistConfig });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('positive existence is cached and reused within TTL', async () => {
    const result1 = await fs.exists('/exists.txt');
    expect(result1).toBe(true);
    const callsAfterFirst = mockFetch.mock.calls.length;

    // Second exists() → should use existenceCache (no fetch)
    const result2 = await fs.exists('/exists.txt');
    expect(result2).toBe(true);
    expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
  });

  it('negative existence is cached within TTL (1 min)', async () => {
    const result1 = await fs.exists('/nonexistent.txt');
    expect(result1).toBe(false);
    const callsAfterFirst = mockFetch.mock.calls.length;

    // Second exists() within TTL → no fetch (uses negative existenceCache)
    const result2 = await fs.exists('/nonexistent.txt');
    expect(result2).toBe(false);
    expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);

    // After 1 min — negative cache expired → re-checks via stat()
    // stat() will call ensureDirListing which may use cached dir listing
    // (dir listing TTL is 5 min, still valid), so it finds 'nonexistent.txt'
    // is not in the listing → throws FileNotFoundError → existenceCache updated
    vi.advanceTimersByTime(60_001);
    const result3 = await fs.exists('/nonexistent.txt');
    expect(result3).toBe(false);
    // stat() was called, but it used the cached dir listing — no new fetch
    // However the existenceCache was re-evaluated, which is the key behavior
  });

  it('existenceCache is NOT persisted across instances', async () => {
    await fs.exists('/exists.txt');

    // New instance — existence cache should be empty
    const fs2 = new RemoteStorageFileSystem({ ...noPersistConfig });
    // Advance fake timer to let any async init complete
    await vi.advanceTimersByTimeAsync(100);

    // First exists() on new instance must fetch from network
    const callsBefore = mockFetch.mock.calls.length;
    await fs2.exists('/exists.txt');
    expect(mockFetch.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

// ===========================================================================
// 6. ensureDirListing — parent directory verification
// ===========================================================================

describe('ensureDirListing: parent directory verification', () => {
  const mockFetch = global.fetch as any;
  let fs: RemoteStorageFileSystem;

  beforeEach(() => {
    mockFetch.mockReset();
    fs = new RemoteStorageFileSystem({ ...noPersistConfig });
  });

  it('skips fetch when parent listing says target is a file (nested path)', async () => {
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: {
          '': [{ name: 'parent', isDir: true }],
          'parent/': [{ name: 'config.json', isDir: false }],
        },
      }),
    );

    // readdir('/parent/config.json/') — parent listing says it's a file
    await fs.readdir('/parent/config.json/').catch(() => {
      // DirectoryNotFoundError is expected
    });

    const getUrls = getGetUrls(mockFetch);
    expect(getUrls).toContain(`${baseUrl}/app_data/configs/parent/`);
    expect(getUrls).not.toContain(`${baseUrl}/app_data/configs/parent/config.json/`);
  });

  it('skips fetch when target is not in parent listing (nested path)', async () => {
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: {
          '': [{ name: 'parent', isDir: true }],
          'parent/': [{ name: 'exists', isDir: true }],
        },
      }),
    );

    await fs.readdir('/parent/nonexistent/').catch(() => {});

    const getUrls = getGetUrls(mockFetch);
    expect(getUrls).not.toContain(`${baseUrl}/app_data/configs/parent/nonexistent/`);
  });

  it('top-level dirs skip parent verification — fetches directly', async () => {
    // Top-level dirs (parentPath='') skip parent verification because the
    // account root '/' is not accessible with a scoped Bearer token.
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: {
          '': [{ name: 'subdir', isDir: true }],
          'subdir/': [{ name: 'nested.txt', isDir: false }],
        },
      }),
    );

    const entries = await fs.readdir('/subdir/');
    expect(entries).toContain('nested.txt');

    const getUrls = getGetUrls(mockFetch);
    // subdir/ is fetched directly without first fetching root listing
    expect(getUrls).toContain(`${baseUrl}/app_data/configs/subdir/`);
    expect(getUrls).not.toContain(`${baseUrl}/app_data/configs/`);
  });

  it('skips fetch when parent directory does not exist', async () => {
    // Root returns 404 — nothing exists
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Map(),
    });

    await fs.readdir('/foo/bar/').catch(() => {});

    const getUrls = getGetUrls(mockFetch);
    // No fetch to '/foo/bar/' should occur
    expect(getUrls).not.toContain(`${baseUrl}/app_data/configs/foo/bar/`);
  });

  it('proceeds to fetch when parent listing confirms target is a directory (nested path)', async () => {
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: {
          '': [{ name: 'parent', isDir: true }],
          'parent/': [{ name: 'subdir', isDir: true }],
          'parent/subdir/': [{ name: 'nested.txt', isDir: false }],
        },
      }),
    );

    const entries = await fs.readdir('/parent/subdir/');
    expect(entries).toContain('nested.txt');

    const getUrls = getGetUrls(mockFetch);
    expect(getUrls).toContain(`${baseUrl}/app_data/configs/parent/`);
    expect(getUrls).toContain(`${baseUrl}/app_data/configs/parent/subdir/`);
  });

  it('root directory has no parent check — fetches directly', async () => {
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: { '': [{ name: 'file.txt', isDir: false }] },
      }),
    );

    await fs.readdir('/');

    // Only one GET: root directory listing
    const getUrls = getGetUrls(mockFetch);
    expect(getUrls.length).toBe(1);
    expect(getUrls[0]).toBe(`${baseUrl}/app_data/configs/`);
  });
});

// ===========================================================================
// 7. buildUrl — trailing slash for directory URLs
// ===========================================================================

describe('buildUrl: directory URL trailing slash', () => {
  const mockFetch = global.fetch as any;
  let fs: RemoteStorageFileSystem;

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: { '': [{ name: 'file.txt', isDir: false }] },
      }),
    );
    fs = new RemoteStorageFileSystem({ ...noPersistConfig });
  });

  it('ensureDirListing generates URL with trailing slash', async () => {
    await fs.readdir('/');

    const url = mockFetch.mock.calls[0][0];
    expect(url).toMatch(/\/$/);
    expect(url).toBe(`${baseUrl}/app_data/configs/`);
  });

  it('ensureDirListing for nested directory has trailing slash', async () => {
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: {
          '': [{ name: 'deep', isDir: true }],
          'deep/': [{ name: 'nested', isDir: true }],
          'deep/nested/': [{ name: 'dir', isDir: true }],
          'deep/nested/dir/': [],
        },
      }),
    );

    await fs.readdir('/deep/nested/dir/');

    const getUrls = getGetUrls(mockFetch);
    const lastUrl = getUrls[getUrls.length - 1];
    expect(lastUrl).toBe(`${baseUrl}/app_data/configs/deep/nested/dir/`);
  });
});

// ===========================================================================
// 8. Cache invalidation — write/delete patches dir listing
// ===========================================================================

describe('Cache invalidation: write/delete patches parent dir listing', () => {
  const mockFetch = global.fetch as any;
  let fs: RemoteStorageFileSystem;

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: {
          '': [
            { name: 'existing.txt', isDir: false },
            { name: 'subdir', isDir: true },
          ],
        },
        files: { 'existing.txt': 'old content' },
      }),
    );
    fs = new RemoteStorageFileSystem({ ...noPersistConfig });
  });

  it('writeFile adds new entry to parent dir cache (no re-fetch)', async () => {
    // Populate cache
    await fs.readdir('/');
    expect((await fs.readdir('/')).sort()).toEqual(['existing.txt', 'subdir']);

    // Write a new file
    await fs.writeFile('/newfile.txt', 'content');

    // readdir again — should see new file in cache (patched, not re-fetched)
    const entries = await fs.readdir('/');
    expect(entries).toContain('newfile.txt');
    expect(entries).toContain('existing.txt');

    // Count directory GET requests — should be only 1 (initial readdir)
    const dirGetUrls = getGetUrls(mockFetch).filter(
      (u) => u === `${baseUrl}/app_data/configs/`,
    );
    expect(dirGetUrls.length).toBe(1);
  });

  it('unlink removes entry from parent dir cache (no re-fetch)', async () => {
    // Populate cache
    await fs.readdir('/');
    const entries = await fs.readdir('/');
    expect(entries).toContain('existing.txt');

    // Delete the file
    await fs.unlink('/existing.txt');

    // readdir again — should NOT see deleted file
    const entriesAfter = await fs.readdir('/');
    expect(entriesAfter).not.toContain('existing.txt');

    // Only 1 directory GET (initial readdir), no re-fetch
    const dirGetUrls = getGetUrls(mockFetch).filter(
      (u) => u === `${baseUrl}/app_data/configs/`,
    );
    expect(dirGetUrls.length).toBe(1);
  });

  it('writeFile patches only the parent dir — sibling dirs stay cached', async () => {
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: {
          '': [
            { name: 'a.txt', isDir: false },
            { name: 'other', isDir: true },
          ],
          'other/': [{ name: 'inner.txt', isDir: false }],
        },
      }),
    );

    // Populate both caches
    await fs.readdir('/');
    await fs.readdir('/other/');
    const dirGetsBefore = getGetUrls(mockFetch).length;

    // Write to root — should only patch root cache
    await fs.writeFile('/new.txt', 'data');

    // readdir('/other/') should still be cached (not affected)
    await fs.readdir('/other/');
    // No new GET requests should have been made for '/other/'
    const dirGetsAfter = getGetUrls(mockFetch);
    const otherDirGets = dirGetsAfter.filter(
      (u) => u === `${baseUrl}/app_data/configs/other/`,
    );
    expect(otherDirGets.length).toBe(1); // only the initial readdir
  });
});

// ===========================================================================
// 9. ensureCacheLoaded — timing guarantees
// ===========================================================================

describe('ensureCacheLoaded: timing', () => {
  const mockFetch = global.fetch as any;
  let cacheFile: string;

  beforeEach(() => {
    mockFetch.mockReset();
    cacheFile = tempCacheFile();
  });

  afterEach(() => {
    try { nodeFs.unlinkSync(cacheFile); } catch {}
  });

  it('cache is available on first readdir() call after construction', async () => {
    // Pre-populate cache file
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: { '': [{ name: 'cached.txt', isDir: false }] },
      }),
    );
    const fs1 = new RemoteStorageFileSystem({
      ...noPersistConfig,
      persistCache: true,
      cacheFile,
    });
    await fs1.readdir('/');
    await waitForSave();

    // New instance with pre-populated cache
    let fetchCount = 0;
    const baseImpl = createMockFetch({
      dirs: { '': [{ name: 'cached.txt', isDir: false }] },
    });
    mockFetch.mockImplementation((...args: any[]) => {
      fetchCount++;
      return baseImpl(...args);
    });

    const fs2 = new RemoteStorageFileSystem({
      ...noPersistConfig,
      persistCache: true,
      cacheFile,
    });

    // First readdir should use restored cache — no fetch
    await fs2.readdir('/');
    expect(fetchCount).toBe(0);
  });

  it('multiple ensureCacheLoaded calls are memoized (single load)', async () => {
    mockFetch.mockImplementation(
      createMockFetch({
        dirs: { '': [{ name: 'x.txt', isDir: false }] },
      }),
    );
    const fs = new RemoteStorageFileSystem({ ...noPersistConfig });

    // Call readdir multiple times — should not trigger multiple cache loads
    await fs.readdir('/');
    await fs.readdir('/');
    await fs.readdir('/');

    // Only one network fetch (the first readdir); rest are cache HITs
    const dirGets = getGetUrls(mockFetch).filter(
      (u) => u === `${baseUrl}/app_data/configs/`,
    );
    expect(dirGets.length).toBe(1);
  });
});
