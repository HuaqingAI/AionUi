/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { ipcBridge } from '@/common';
import { ProcessConfig } from '@process/utils/initStorage';
import { getZoomFactor, setZoomFactor } from '@process/utils/zoom';
import { getCdpStatus, updateCdpConfig } from '@process/utils/configureChromium';
import { getGpuStatus, setGpuUserOverride } from '@process/utils/gpuRecovery';
import { initApplicationBridgeCore } from './applicationBridgeCore';
import type { IStartOnBootStatus } from '@/common/adapter/ipcBridge';
import { restartApplication } from './restartApplication';
import { HTHAuthService } from '@process/services/hth/authService';
import { HTHConfigSyncService } from '@process/services/hth/configSyncService';
import { HTHQuotaService } from '@process/services/hth/quotaService';

let mainWindowRef: BrowserWindow | null = null;

const START_ON_BOOT_UNSUPPORTED_MESSAGE = 'Start on boot is only available in packaged macOS and Windows apps.';
export const START_ON_BOOT_WINDOWS_ARG = '--start-on-boot';

const isStartOnBootSupported = (): boolean => {
  return app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32');
};

const getStartOnBootWindowsArgs = (): string[] => [START_ON_BOOT_WINDOWS_ARG];

const getLoginItemSettings = () => {
  return process.platform === 'win32'
    ? app.getLoginItemSettings({ args: getStartOnBootWindowsArgs() })
    : app.getLoginItemSettings();
};

export function wasLaunchedAtLogin(): boolean {
  if (!app.isPackaged) {
    return false;
  }

  if (process.platform === 'darwin') {
    return Boolean(getLoginItemSettings().wasOpenedAtLogin);
  }

  if (process.platform === 'win32') {
    return process.argv.includes(START_ON_BOOT_WINDOWS_ARG);
  }

  return false;
}

export function getStartOnBootStatus(): IStartOnBootStatus {
  if (!isStartOnBootSupported()) {
    return {
      supported: false,
      enabled: false,
      isPackaged: app.isPackaged,
      platform: process.platform,
    };
  }

  const settings = getLoginItemSettings();
  const enabled =
    process.platform === 'win32'
      ? Boolean(settings.openAtLogin || settings.executableWillLaunchAtLogin)
      : Boolean(settings.openAtLogin);

  return {
    supported: true,
    enabled,
    isPackaged: app.isPackaged,
    platform: process.platform,
  };
}

export function setStartOnBootEnabled(enabled: boolean): IStartOnBootStatus {
  const currentStatus = getStartOnBootStatus();
  if (!currentStatus.supported) {
    return currentStatus;
  }

  app.setLoginItemSettings({
    openAtLogin: enabled,
    ...(process.platform === 'win32'
      ? {
          args: getStartOnBootWindowsArgs(),
          enabled: true,
        }
      : {}),
  });

  return getStartOnBootStatus();
}

export function setApplicationMainWindow(win: BrowserWindow): void {
  mainWindowRef = win;
}

function showHTHLoginWindow(): void {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    return;
  }
  if (process.platform === 'darwin' && app.dock) {
    void app.dock.show();
  }
  if (mainWindowRef.isMinimized()) {
    mainWindowRef.restore();
  }
  mainWindowRef.show();
  mainWindowRef.focus();
}

export function initApplicationBridge(): void {
  // Platform-agnostic handlers: systemInfo, updateSystemInfo, getPath
  initApplicationBridgeCore();

  ipcBridge.application.restart.provider(async () => {
    // Backend subprocess shutdown is handled by backendManager.stop() in the
    // main window's before-quit hook; agent children are killed transitively
    // when backend exits.
    return restartApplication(app);
  });

  ipcBridge.application.isDevToolsOpened.provider(() => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      return Promise.resolve(mainWindowRef.webContents.isDevToolsOpened());
    }
    return Promise.resolve(false);
  });

  ipcBridge.application.openDevTools.provider(() => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      const win = mainWindowRef;
      const wasOpen = win.webContents.isDevToolsOpened();

      if (wasOpen) {
        win.webContents.closeDevTools();
        return Promise.resolve(false);
      } else {
        return new Promise((resolve) => {
          const onOpened = () => {
            win.webContents.off('devtools-opened', onOpened);
            resolve(true);
          };

          win.webContents.once('devtools-opened', onOpened);
          win.webContents.openDevTools();

          setTimeout(() => {
            win.webContents.off('devtools-opened', onOpened);
            if (win.isDestroyed()) {
              resolve(false);
              return;
            }
            resolve(win.webContents.isDevToolsOpened());
          }, 500);
        });
      }
    }
    return Promise.resolve(false);
  });

  ipcBridge.application.getZoomFactor.provider(() => Promise.resolve(getZoomFactor()));

  ipcBridge.application.setZoomFactor.provider(async ({ factor }) => {
    const updatedFactor = setZoomFactor(factor);
    try {
      await ProcessConfig.set('ui.zoomFactor', updatedFactor);
    } catch (error) {
      console.error('[ApplicationBridge] Failed to persist zoom factor:', error);
    }
    return updatedFactor;
  });

  ipcBridge.application.writeRendererLog.provider(async ({ level, tag, message, data }) => {
    const prefix = `[Renderer:${tag}] ${message}`;
    const args = data === undefined ? [prefix] : [prefix, data];
    if (level === 'error') {
      console.error(...args);
    } else if (level === 'warn') {
      console.warn(...args);
    } else if (level === 'debug') {
      console.debug(...args);
    } else {
      console.info(...args);
    }
  });

  // CDP status and configuration
  ipcBridge.application.getCdpStatus.provider(async () => {
    try {
      const status = getCdpStatus();
      // If port is set, CDP is considered enabled (verification is optional)
      return { success: true, data: status };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.updateCdpConfig.provider(async (config) => {
    try {
      const updatedConfig = updateCdpConfig(config);
      return { success: true, data: updatedConfig };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.getStartOnBootStatus.provider(async () => {
    try {
      return { success: true, data: getStartOnBootStatus() };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.setStartOnBoot.provider(async ({ enabled }) => {
    try {
      const status = setStartOnBootEnabled(enabled);
      if (!status.supported) {
        return { success: false, msg: START_ON_BOOT_UNSUPPORTED_MESSAGE, data: status };
      }
      return { success: true, data: status };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.getGpuStatus.provider(async () => {
    try {
      return { success: true, data: getGpuStatus() };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.setGpuOverride.provider(async ({ override }) => {
    try {
      return { success: true, data: setGpuUserOverride(override) };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  const hthAuthService = new HTHAuthService(undefined, { onLoginComplete: showHTHLoginWindow });
  const hthConfigSyncService = new HTHConfigSyncService(hthAuthService);
  const hthQuotaService = new HTHQuotaService(hthAuthService);

  ipcBridge.hth.authStatus.provider(() => hthAuthService.getStatus());
  ipcBridge.hth.startLogin.provider((request) => hthAuthService.startLogin(request));
  ipcBridge.hth.exchangeLoginCode.provider((request) => hthAuthService.exchangeLoginCode(request));
  ipcBridge.hth.logout.provider(() => hthAuthService.logout());
  ipcBridge.hth.syncAgentConfigs.provider((request) => hthConfigSyncService.syncAgentConfigs(request));
  ipcBridge.hth.injectProjectConfig.provider((request) => hthConfigSyncService.injectProjectConfig(request));
  ipcBridge.hth.quotaSummary.provider(() => hthQuotaService.getSummary());
  ipcBridge.hth.refreshQuotaSummary.provider(() => hthQuotaService.refreshSummary());
}
