/**
 * Tests for hiding the internal `.keep` placeholder from callers.
 *
 * `.keep` keeps otherwise-empty directories alive in RemoteStorage (which, like
 * Git, cannot store empty directories). It is backend-internal and MUST be
 * hidden from readdir() per the backend contract (zen-fs-sync/docs/SyncableFS.md
 * §1/§2). If it leaks, the sync engine treats it as a user file and churns it
 * across backends.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemoteStorageFileSystem } from '../src/RemoteStorageFileSystem.js';
import { RemoteStorageConfig } from '../src/types.js';

global.fetch = vi.fn();

const baseUrl = 'https://storage.example.com/user';

/** Mock fetch serving RemoteStorage folder listings (ld+json @graph). */
function createMockFetch(dirListing: Record<string, { name: string; isDir: boolean }[]>) {
  return vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'GET') {
      for (const [dirPath, items] of Object.entries(dirListing)) {
        const dirUrl = `${baseUrl}/app_data/${dirPath}`;
        if (url === dirUrl) {
          const graph = items.map((item) => ({
            '@id': item.isDir ? item.name + '/' : item.name,
            ETag: 'etag-' + item.name,
          }));
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map([
              ['content-type', 'application/ld+json'],
              ['ETag', 'dir-etag-' + dirPath],
            ]),
            json: () => Promise.resolve({ '@graph': graph }),
          });
        }
      }
    }
    return Promise.resolve({ ok: false, status: 404, headers: new Map() });
  });
}

const config: RemoteStorageConfig = {
  href: baseUrl,
  token: 'test-token',
  basePath: '/app_data/',
  preciseMtime: false, // sidecars are irrelevant to this test
};

describe('RemoteStorageFileSystem: .keep hidden from readdir', () => {
  const mockFetch = global.fetch as any;
  let fs: RemoteStorageFileSystem;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('readdir hides .keep mixed with real files', async () => {
    mockFetch.mockImplementation(
      createMockFetch({
        '': [{ name: '.keep', isDir: false }, { name: 'a.json', isDir: false }],
      }),
    );
    fs = new RemoteStorageFileSystem(config);

    const entries = await fs.readdir('/');
    expect(entries).toContain('a.json');
    expect(entries).not.toContain('.keep');
  });

  it('a directory that only contains .keep reads as empty', async () => {
    mockFetch.mockImplementation(
      createMockFetch({
        '': [{ name: 'sub', isDir: true }],
        'sub/': [{ name: '.keep', isDir: false }],
      }),
    );
    fs = new RemoteStorageFileSystem(config);

    const entries = await fs.readdir('/sub');
    expect(entries).toEqual([]);
  });
});
