/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { Menu, app, dialog } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import i18n from '@process/services/i18n';

/** Enable native image clipboard and save-dialog actions in the desktop window. */
export function setupImageContextMenu(window: BrowserWindow): void {
  const { webContents } = window;
  webContents.on('context-menu', (_event, params) => {
    if (params.mediaType !== 'image') return;

    Menu.buildFromTemplate([
      {
        label: i18n.t('preview.copyImage'),
        enabled: params.hasImageContents,
        click: () => {
          if (!webContents.isDestroyed()) webContents.copyImageAt(params.x, params.y);
        },
      },
      {
        label: i18n.t('preview.saveImageAs'),
        enabled: !!params.srcURL || params.hasImageContents,
        click: async () => {
          if (window.isDestroyed() || webContents.isDestroyed()) return;
          try {
            let srcURL = params.srcURL;
            if (!srcURL) {
              // Chromium drops URLs over 2 MiB from native context-menu events; read the original in its frame.
              const zoomFactor = webContents.getZoomFactor();
              const source: unknown = await params.frame?.executeJavaScript(`(() => {
                const [x, y] = ${JSON.stringify([params.x / zoomFactor, params.y / zoomFactor])};
                let element = document.elementFromPoint(x, y);
                while (element?.shadowRoot) element = element.shadowRoot.elementFromPoint(x, y);
                return element instanceof HTMLImageElement ? element.currentSrc || element.src : '';
              })()`);
              if (typeof source === 'string') srcURL = source;
            }
            if (!srcURL) throw new Error('Image source is unavailable');

            const sourceURL = new URL(srcURL);
            const isDataURL = sourceURL.protocol === 'data:';
            const imageType = /^data:image\/([^;,]+)/i.exec(srcURL)?.[1] || 'png';
            const extension = imageType === 'jpeg' ? 'jpg' : imageType === 'svg+xml' ? 'svg' : imageType;
            const defaultPath = isDataURL
              ? `image.${extension}`
              : path.basename(decodeURIComponent(sourceURL.pathname)) || 'image.png';
            const { canceled, filePath } = await dialog.showSaveDialog(window, {
              title: i18n.t('preview.saveImageAs'),
              defaultPath,
            });
            if (canceled || !filePath || webContents.isDestroyed()) return;

            let imageData: Buffer;
            if (isDataURL) {
              // Local chat images are data URLs; preserve their bytes without Chromium's URL-size limits.
              const separator = srcURL.indexOf(',');
              if (separator < 0) throw new Error('Invalid image data URL');
              const header = srcURL.slice(0, separator);
              const data = srcURL.slice(separator + 1);
              imageData = /;base64$/i.test(header)
                ? Buffer.from(data, 'base64')
                : Buffer.from(decodeURIComponent(data));
            } else {
              const response = await webContents.session.fetch(srcURL);
              if (!response.ok) throw new Error(`Image request failed: ${response.status}`);
              imageData = Buffer.from(await response.arrayBuffer());
            }
            await writeFile(filePath, imageData);
          } catch (error) {
            console.error('[ImageContextMenu] Failed to save image:', error);
            dialog.showErrorBox(i18n.t('preview.saveImageAs'), i18n.t('common.saveFailed'));
          }
        },
      },
    ]).popup({ window });
  });
}

export function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? ([{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }] as MenuItemConstructorOptions[])
        : ([{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }] as MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  template.push({
    label: 'Help',
    submenu: [
      {
        label: 'Check for Updates...',
        click: () => {
          ipcBridge.update.open.emit({ source: 'menu' });
        },
      },
    ],
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
