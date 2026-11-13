/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { Debugger } from 'electron';
import { parseBrowserStorageState, type BrowserCookie, type BrowserOriginStorage } from './storageState';

export type StorageImportTarget = {
  debugger: Pick<Debugger, 'sendCommand' | 'on' | 'removeListener'>;
  getURL: () => string;
  loadURL: (url: string) => Promise<unknown>;
};

export type StorageImportResult = {
  cookiesImported: number;
  localStorageImported: number;
  originsImported: number;
  skippedExpiredCookies: number;
  failures: Array<{ kind: 'cookie' | 'origin'; index: number; message: string }>;
};

type StorageImportDependencies = {
  setCookie: (cookie: BrowserCookie) => Promise<void>;
  flush: () => Promise<void>;
  target: StorageImportTarget;
};

const MAX_STATE_FILE_BYTES = 10 * 1024 * 1024;

/** Read a bounded JSON file without including credential values in parse errors. */
export async function readStorageStateFile(filePath: string): Promise<unknown> {
  if (!path.isAbsolute(filePath) || filePath.includes('\0'))
    throw new Error('Storage-state file path must be absolute.');
  let file;
  try {
    file = await open(filePath, 'r');
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_STATE_FILE_BYTES) throw new Error('invalid');
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_STATE_FILE_BYTES + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_STATE_FILE_BYTES || bytesRead > info.size) throw new Error('invalid');
    try {
      return JSON.parse(
        buffer
          .subarray(0, bytesRead)
          .toString('utf8')
          .replace(/^\uFEFF/, '')
      ) as unknown;
    } catch {
      throw new Error('Storage-state file must contain valid JSON.');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Storage-state file must contain valid JSON.') throw error;
    throw new Error('Storage-state file could not be read or exceeds the 10 MB limit.');
  } finally {
    await file?.close();
  }
}

/** Restore an origin on a synthetic intercepted document so site redirects and scripts cannot race restoration. */
export async function restoreOriginStorage(target: StorageImportTarget, storage: BrowserOriginStorage): Promise<void> {
  const url = `${storage.origin}/__aionui_storage_import__${randomUUID()}`;
  let interceptionFailure: unknown;
  const onMessage = (_event: unknown, method: string, params: Record<string, unknown>): void => {
    if (method !== 'Fetch.requestPaused' || typeof params.requestId !== 'string') return;
    const request = params.request;
    const matches = request !== null && typeof request === 'object' && 'url' in request && request.url === url;
    const command = matches ? 'Fetch.fulfillRequest' : 'Fetch.continueRequest';
    const commandParams = matches
      ? {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: Buffer.from('<!doctype html><meta charset="utf-8"><title></title>').toString('base64'),
        }
      : { requestId: params.requestId };
    void target.debugger.sendCommand(command, commandParams).catch((error: unknown) => {
      interceptionFailure = error;
      void target.debugger
        .sendCommand('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' })
        .catch((): undefined => undefined);
    });
  };
  target.debugger.on('message', onMessage);
  try {
    await target.debugger.sendCommand('Network.setBypassServiceWorker', { bypass: true });
    await target.debugger.sendCommand('Fetch.enable', {
      patterns: [{ urlPattern: url, resourceType: 'Document', requestStage: 'Request' }],
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        target.loadURL(url),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Storage document preparation timed out.')), 10_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (interceptionFailure) throw new Error('Storage document could not be prepared.');
    const result = (await target.debugger.sendCommand('Runtime.evaluate', {
      expression: `(() => { if (location.origin !== ${JSON.stringify(storage.origin)}) throw new Error('origin mismatch'); for (const entry of ${JSON.stringify(storage.entries)}) localStorage.setItem(entry.name, entry.value); return true; })()`,
      returnByValue: true,
    })) as { exceptionDetails?: unknown; result?: { value?: unknown } };
    if (result.exceptionDetails || result.result?.value !== true)
      throw new Error('Local Storage could not be restored.');
  } finally {
    await target.debugger.sendCommand('Fetch.disable').catch((): undefined => undefined);
    await target.debugger
      .sendCommand('Network.setBypassServiceWorker', { bypass: false })
      .catch((): undefined => undefined);
    target.debugger.removeListener('message', onMessage);
  }
}

/** Import validated credentials into the persistent in-app session, reporting counts without exposing values. */
export async function importBrowserStorageState(
  filePath: string,
  origin: string | undefined,
  dependencies: StorageImportDependencies
): Promise<StorageImportResult> {
  const state = parseBrowserStorageState(await readStorageStateFile(filePath), origin);
  const result: StorageImportResult = {
    cookiesImported: 0,
    localStorageImported: 0,
    originsImported: 0,
    skippedExpiredCookies: state.skippedExpiredCookies,
    failures: [],
  };
  for (const [index, cookie] of state.cookies.entries()) {
    try {
      await dependencies.setCookie(cookie);
      result.cookiesImported += 1;
    } catch {
      result.failures.push({ kind: 'cookie', index, message: 'Cookie was rejected by the browser.' });
    }
  }
  const originalUrl = dependencies.target.getURL() || 'about:blank';
  try {
    for (const [index, storage] of state.origins.entries()) {
      try {
        await restoreOriginStorage(dependencies.target, storage);
        result.originsImported += 1;
        result.localStorageImported += storage.entries.length;
      } catch {
        result.failures.push({
          kind: 'origin',
          index,
          message: 'Local Storage could not be restored for this origin.',
        });
      }
    }
  } finally {
    if (state.origins.length > 0) {
      await dependencies.target.loadURL(originalUrl).catch((): undefined => undefined);
    }
    await dependencies.flush();
  }
  return result;
}
