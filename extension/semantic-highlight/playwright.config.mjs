import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results',
  timeout: 45_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { screenshot: 'off', trace: 'off' },
});
