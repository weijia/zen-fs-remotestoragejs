import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    outDir: 'dist',
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    target: 'es2020',
    platform: 'neutral',
    external: ['@zenfs/core', 'remotestoragejs'],
  },
  {
    entry: { 'zen-fs-remotestoragejs': 'src/index.ts' },
    format: ['iife'],
    globalName: 'ZenFSRemoteStorage',
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    platform: 'browser',
    // Bundle all dependencies for browser IIFE usage
    external: [],
  },
]);
