/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type {
  BrowserWindow,
  ContextMenuParams,
  KeyboardEvent,
  MenuItem,
  MenuItemConstructorOptions,
  SaveDialogOptions,
  SaveDialogReturnValue,
} from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupImageContextMenu } from '@/process/utils/appMenu';

const mocks = vi.hoisted(() => ({
  popup: vi.fn(),
  buildFromTemplate: vi.fn<(template: MenuItemConstructorOptions[]) => { popup: (...args: unknown[]) => void }>(),
  translate: vi.fn<(key: string) => string>(),
  showSaveDialog: vi.fn<(window: BrowserWindow, options: SaveDialogOptions) => Promise<SaveDialogReturnValue>>(),
  showErrorBox: vi.fn(),
  fetch: vi.fn<(url: string) => Promise<Response>>(),
  writeFile: vi.fn<(path: string, bytes: Buffer) => Promise<void>>(),
}));

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
  app: {},
  dialog: { showSaveDialog: mocks.showSaveDialog, showErrorBox: mocks.showErrorBox },
}));

vi.mock('@/common', () => ({ ipcBridge: {} }));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  writeFile: mocks.writeFile,
}));

vi.mock('@process/services/i18n', () => ({
  default: { t: mocks.translate },
}));

const createWindow = () => {
  const webContents = Object.assign(new EventEmitter(), {
    copyImageAt: vi.fn(),
    isDestroyed: vi.fn(() => false),
    getZoomFactor: vi.fn(() => 1),
    session: { fetch: mocks.fetch },
  });
  const window = { webContents, isDestroyed: vi.fn(() => false) } as unknown as BrowserWindow;
  setupImageContextMenu(window);
  return { window, webContents };
};

const imageParams: Pick<ContextMenuParams, 'mediaType' | 'hasImageContents' | 'srcURL' | 'x' | 'y'> = {
  mediaType: 'image',
  hasImageContents: true,
  srcURL: 'https://example.com/original.png',
  x: 42,
  y: 71,
};

const clickMenuItem = (label: string) => {
  const template = mocks.buildFromTemplate.mock.calls.at(-1)?.[0];
  const item = template?.find((entry) => entry.label === label);
  expect(item?.click).toBeTypeOf('function');
  return item?.click?.({} as MenuItem, undefined, {} as KeyboardEvent);
};

describe('image context menu', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.buildFromTemplate.mockReturnValue({ popup: mocks.popup });
    mocks.translate.mockImplementation((key) => key);
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/saved/poster.png' });
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array([0, 255, 16, 128])));
    mocks.writeFile.mockResolvedValue(undefined);
  });

  it.each(['none', 'video'] as const)('does not show an image menu for %s content', (mediaType) => {
    const { webContents } = createWindow();
    webContents.emit('context-menu', {}, { ...imageParams, mediaType });

    expect(mocks.buildFromTemplate).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'copying an unloaded image', params: { hasImageContents: false }, enabled: [false, true] },
    {
      action: 'saving an image with neither a source URL nor loaded contents',
      params: { srcURL: '', hasImageContents: false },
      enabled: [false, false],
    },
  ])('disables $action', ({ params, enabled }) => {
    const { webContents } = createWindow();
    webContents.emit('context-menu', {}, { ...imageParams, ...params });

    expect(mocks.buildFromTemplate.mock.calls[0][0].map((entry) => entry.enabled)).toEqual(enabled);
  });

  it('copies the image at the original click coordinates in the originating window', () => {
    const first = createWindow();
    const second = createWindow();
    first.webContents.emit('context-menu', {}, imageParams);

    clickMenuItem('preview.copyImage');

    expect(mocks.popup).toHaveBeenCalledWith({ window: first.window });
    expect(first.webContents.copyImageAt).toHaveBeenCalledWith(42, 71);
    expect(second.webContents.copyImageAt).not.toHaveBeenCalled();
  });

  it('prompts in the originating window and saves the original remote image bytes to the chosen path', async () => {
    const { window, webContents } = createWindow();
    const srcURL = 'https://example.com/autumn%20poster.png?size=full';
    webContents.emit('context-menu', {}, { ...imageParams, srcURL });

    await clickMenuItem('preview.saveImageAs');

    expect(mocks.showSaveDialog).toHaveBeenCalledWith(window, {
      title: 'preview.saveImageAs',
      defaultPath: 'autumn poster.png',
    });
    expect(mocks.fetch).toHaveBeenCalledWith(srcURL);
    expect(mocks.writeFile).toHaveBeenCalledWith('/saved/poster.png', Buffer.from([0, 255, 16, 128]));
  });

  it('recovers and saves a large local image when Chromium omits its source URL', async () => {
    const { webContents } = createWindow();
    const originalBytes = Buffer.alloc(2 * 1024 * 1024 + 1, 0xab);
    const srcURL = `data:image/png;base64,${originalBytes.toString('base64')}`;
    const frame = { executeJavaScript: vi.fn().mockResolvedValue(srcURL) };
    webContents.emit('context-menu', {}, { ...imageParams, srcURL: '', frame });

    await clickMenuItem('preview.saveImageAs');

    expect(
      mocks.buildFromTemplate.mock.calls[0][0].find((entry) => entry.label === 'preview.saveImageAs')?.enabled
    ).toBe(true);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledWith('/saved/poster.png', originalBytes);
  });

  it('preserves URI-encoded SVG content and suggests its original format', async () => {
    const { webContents } = createWindow();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>海报</text></svg>';
    webContents.emit('context-menu', {}, { ...imageParams, srcURL: `data:image/svg+xml,${encodeURIComponent(svg)}` });

    await clickMenuItem('preview.saveImageAs');

    expect(mocks.showSaveDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ defaultPath: 'image.svg' })
    );
    expect(mocks.writeFile).toHaveBeenCalledWith('/saved/poster.png', Buffer.from(svg));
  });

  it('does not fetch or write the image when the save dialog is canceled', async () => {
    const { webContents } = createWindow();
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    webContents.emit('context-menu', {}, imageParams);

    await clickMenuItem('preview.saveImageAs');

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('does not save an unsuccessful image response and shows a localized error', async () => {
    const { webContents } = createWindow();
    mocks.fetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    webContents.emit('context-menu', {}, imageParams);

    try {
      await clickMenuItem('preview.saveImageAs');

      expect(mocks.writeFile).not.toHaveBeenCalled();
      expect(mocks.showErrorBox).toHaveBeenCalledWith('preview.saveImageAs', 'common.saveFailed');
    } finally {
      logError.mockRestore();
    }
  });

  it('shows a localized error if the image source cannot be recovered', async () => {
    const { webContents } = createWindow();
    const frame = { executeJavaScript: vi.fn().mockResolvedValue('') };
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    webContents.emit('context-menu', {}, { ...imageParams, srcURL: '', frame });

    try {
      await clickMenuItem('preview.saveImageAs');

      expect(mocks.showSaveDialog).not.toHaveBeenCalled();
      expect(mocks.writeFile).not.toHaveBeenCalled();
      expect(mocks.showErrorBox).toHaveBeenCalledWith('preview.saveImageAs', 'common.saveFailed');
    } finally {
      logError.mockRestore();
    }
  });

  it('shows a localized error when the selected destination cannot be written', async () => {
    const { webContents } = createWindow();
    mocks.writeFile.mockRejectedValueOnce(new Error('Permission denied'));
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    webContents.emit('context-menu', {}, imageParams);

    try {
      await clickMenuItem('preview.saveImageAs');

      expect(mocks.showErrorBox).toHaveBeenCalledWith('preview.saveImageAs', 'common.saveFailed');
    } finally {
      logError.mockRestore();
    }
  });

  it('ignores image actions if the originating web contents are destroyed after opening the menu', async () => {
    const { webContents } = createWindow();
    webContents.emit('context-menu', {}, imageParams);
    webContents.isDestroyed.mockReturnValue(true);

    clickMenuItem('preview.copyImage');
    await clickMenuItem('preview.saveImageAs');

    expect(webContents.copyImageAt).not.toHaveBeenCalled();
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
  });

  it('uses the current language each time the image menu opens', () => {
    const { webContents } = createWindow();
    mocks.translate.mockImplementation((key) => `en:${key}`);
    webContents.emit('context-menu', {}, imageParams);
    mocks.translate.mockImplementation((key) => `zh:${key}`);
    webContents.emit('context-menu', {}, imageParams);

    expect(mocks.buildFromTemplate.mock.calls.map(([template]) => template.map((entry) => entry.label))).toEqual([
      ['en:preview.copyImage', 'en:preview.saveImageAs'],
      ['zh:preview.copyImage', 'zh:preview.saveImageAs'],
    ]);
  });
});
