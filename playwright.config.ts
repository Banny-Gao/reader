import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 6_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: './e2e/.artifacts',
  use: {
    baseURL: 'http://localhost:5173',
    // 用视口而不是 isMobile 模拟：沙箱里的 chromium 无头模式跑不了移动端模拟，
    // 而手势测试本身走的是 PointerEvent（鼠标），不依赖 touch
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: false,
    isMobile: false,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite --host 0.0.0.0 --port 5173',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
