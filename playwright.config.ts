import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 60_000,
  use: {
    browserName: 'chromium',
    launchOptions: { args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'], executablePath: process.env.WUI_TEST_CHROMIUM }
  }
});
