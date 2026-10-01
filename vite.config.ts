/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// One self-contained dist/index.html: JS, CSS, fonts and the HEIC decoder all inlined.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 10_000 },
  test: { include: ['tests/unit/**/*.test.ts'] },
});
