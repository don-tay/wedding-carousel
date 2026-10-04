import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  reporter: 'list',
  use: { viewport: { width: 1920, height: 1080 } },
  // Serves dist/ over http like GitHub Pages (some storage APIs are unavailable on file:// pages).
  webServer: { command: 'npx vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: true },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 } },
  ],
});
