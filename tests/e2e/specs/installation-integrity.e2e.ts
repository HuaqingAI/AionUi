/**
 * Installation integrity failures happen before the normal app shell is ready,
 * so this spec launches its own Electron instance with a debug startup-failure
 * injection instead of using the shared app fixture.
 */
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import path from 'path';

async function resolveMainWindow(electronApp: ElectronApplication): Promise<Page> {
  const existingMainWindow = electronApp.windows().find((win) => !win.url().startsWith('devtools://'));
  if (existingMainWindow) {
    await existingMainWindow.waitForLoadState('domcontentloaded');
    return existingMainWindow;
  }

  const page = await electronApp.waitForEvent('window', { timeout: 30_000 });
  await page.waitForLoadState('domcontentloaded');
  return page;
}

test.describe('Installation integrity failure dialog', () => {
  test('offers only the latest-download action for an incomplete installation', async () => {
    const projectRoot = path.resolve(__dirname, '../../..');
    const electronApp = await electron.launch({
      args: ['.'],
      cwd: projectRoot,
      env: {
        ...process.env,
        AIONUI_DEBUG_BACKEND_STARTUP_FAILURE: 'backend_incomplete_installation',
        AIONUI_DISABLE_AUTO_UPDATE: '1',
        AIONUI_DISABLE_DEVTOOLS: '1',
        AIONUI_E2E_TEST: '1',
        AIONUI_CDP_PORT: '0',
        NODE_ENV: 'development',
      },
      timeout: 60_000,
    });

    try {
      const page = await resolveMainWindow(electronApp);

      await expect(page.getByTestId('installation-integrity-dialog')).toBeVisible();
      await expect(page.getByTestId('installation-integrity-description')).toContainText('华青智能助手');
      await expect(page.getByTestId('installation-integrity-report')).toHaveCount(0);
      await expect(page.getByTestId('installation-integrity-download')).toBeVisible();

      await page.evaluate(() => {
        window.open = (url) => {
          document.documentElement.dataset.downloadUrl = String(url);
          return null;
        };
      });
      await page.getByTestId('installation-integrity-download').click();

      await expect(page.locator('html')).toHaveAttribute('data-download-url', 'https://hth.huaqing.run/downloads');
    } finally {
      await electronApp.close();
    }
  });
});
