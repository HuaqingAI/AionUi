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
  failures: Array<{ kind: 'cookie' | 'origin'; index: number; code: StorageImportFailureCode; message: string }>;
};

type StorageImportFailureCode =
  | 'BROWSER_CONNECTION_LOST'
  | 'COOKIE_REJECTED'
  | 'COOKIE_INVALID_PARAMETERS'
  | 'COOKIE_HTTP_ONLY_CONFLICT'
  | 'COOKIE_SECURE_CONFLICT'
  | 'COOKIE_SAMESITE_REJECTED'
  | 'COOKIE_TOO_LARGE'
  | 'COOKIE_INVALID_DOMAIN'
  | 'COOKIE_STORAGE_FAILED'
  | 'STORAGE_DOCUMENT_TIMEOUT'
  | 'STORAGE_NAVIGATION_ABORTED'
  | 'STORAGE_DOCUMENT_FAILED'
  | 'LOCAL_STORAGE_WRITE_FAILED';

class StorageImportError extends Error {
  constructor(readonly code: StorageImportFailureCode) {
    super(code);
  }
}

/** Retain only known failure categories; raw browser errors can contain imported credentials. */
function failureCode(error: unknown, fallback: StorageImportFailureCode): StorageImportFailureCode {
  if (error instanceof StorageImportError) return error.code;
  const message = error instanceof Error ? error.message : '';
  if (
    /debugger is not attached|target closed|session closed|no target with given id|inspected target.*closed/i.test(
      message
    )
  )
    return 'BROWSER_CONNECTION_LOST';
  if (!fallback.startsWith('COOKIE_')) {
    const navigationError = error as { code?: unknown; errno?: unknown } | null | undefined;
    if (
      fallback === 'STORAGE_DOCUMENT_FAILED' &&
      (navigationError?.code === 'ERR_ABORTED' || navigationError?.errno === -3 || /\bERR_ABORTED\b/.test(message))
    )
      return 'STORAGE_NAVIGATION_ABORTED';
    return fallback;
  }
  const cookieErrors: Array<[RegExp, StorageImportFailureCode]> = [
    [/EXCLUDE_OVERWRITE_HTTP_ONLY/, 'COOKIE_HTTP_ONLY_CONFLICT'],
    [/EXCLUDE_OVERWRITE_SECURE/, 'COOKIE_SECURE_CONFLICT'],
    [/EXCLUDE_SAMESITE_/, 'COOKIE_SAMESITE_REJECTED'],
    [/EXCLUDE_(?:NAME_VALUE_PAIR|ATTRIBUTE_VALUE)_EXCEEDS_MAX_SIZE/, 'COOKIE_TOO_LARGE'],
    [/EXCLUDE_(?:INVALID_DOMAIN|DOMAIN_MISMATCH)/, 'COOKIE_INVALID_DOMAIN'],
    [/EXCLUDE_FAILURE_TO_STORE/, 'COOKIE_STORAGE_FAILED'],
    [/Invalid cookie fields|Invalid parameters/i, 'COOKIE_INVALID_PARAMETERS'],
  ];
  return cookieErrors.find(([pattern]) => pattern.test(message))?.[1] ?? fallback;
}

/** Write with the browser's privileged CDP API while preserving the exported HttpOnly attribute. */
export async function setBrowserCookie(
  target: Pick<StorageImportTarget, 'debugger'>,
  cookie: BrowserCookie
): Promise<void> {
  const sameSites = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' } as const;
  try {
    const result = (await target.debugger.sendCommand('Network.setCookie', {
      url: cookie.url,
      name: cookie.name,
      value: cookie.value,
      ...(cookie.domain ? { domain: cookie.domain } : {}),
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      ...(cookie.sameSite !== 'unspecified' ? { sameSite: sameSites[cookie.sameSite] } : {}),
      ...(cookie.expirationDate !== undefined ? { expires: cookie.expirationDate } : {}),
    })) as { success?: boolean } | undefined;
    if (result?.success !== true) throw new StorageImportError('COOKIE_REJECTED');
  } catch (error) {
    throw new StorageImportError(failureCode(error, 'COOKIE_REJECTED'));
  }
}

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
  let stage: StorageImportFailureCode = 'STORAGE_DOCUMENT_FAILED';
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
          timeout = setTimeout(() => reject(new StorageImportError('STORAGE_DOCUMENT_TIMEOUT')), 10_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (interceptionFailure) throw interceptionFailure;
    stage = 'LOCAL_STORAGE_WRITE_FAILED';
    const result = (await target.debugger.sendCommand('Runtime.evaluate', {
      expression: `(() => { if (location.origin !== ${JSON.stringify(storage.origin)}) throw new Error('origin mismatch'); for (const entry of ${JSON.stringify(storage.entries)}) localStorage.setItem(entry.name, entry.value); return true; })()`,
      returnByValue: true,
    })) as { exceptionDetails?: unknown; result?: { value?: unknown } };
    if (result.exceptionDetails || result.result?.value !== true)
      throw new StorageImportError('LOCAL_STORAGE_WRITE_FAILED');
  } catch (error) {
    throw new StorageImportError(failureCode(error, stage));
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
    } catch (error) {
      result.failures.push({
        kind: 'cookie',
        index,
        code: failureCode(error, 'COOKIE_REJECTED'),
        message: 'Cookie was rejected by the browser.',
      });
    }
  }
  const originalUrl = dependencies.target.getURL() || 'about:blank';
  try {
    for (const [index, storage] of state.origins.entries()) {
      try {
        await restoreOriginStorage(dependencies.target, storage);
        result.originsImported += 1;
        result.localStorageImported += storage.entries.length;
      } catch (error) {
        result.failures.push({
          kind: 'origin',
          index,
          code: failureCode(error, 'LOCAL_STORAGE_WRITE_FAILED'),
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
