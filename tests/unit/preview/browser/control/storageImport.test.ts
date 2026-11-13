import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  importBrowserStorageState,
  readStorageStateFile,
  restoreOriginStorage,
  type StorageImportTarget,
} from '@/process/resources/builtinMcp/browser/storageImport';

const directories: string[] = [];
const stateFile = async (state: unknown): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-state-test-'));
  directories.push(directory);
  const file = path.join(directory, 'state.json');
  await fs.writeFile(file, JSON.stringify(state));
  return file;
};

const target = () => {
  const events = new EventEmitter();
  const sendCommand = vi.fn(async (method: string) =>
    method === 'Runtime.evaluate' ? { result: { value: true } } : {}
  );
  const loadURL = vi.fn(async (url: string) => {
    if (url.includes('__aionui_storage_import__')) {
      events.emit('message', {}, 'Fetch.requestPaused', { requestId: 'document', request: { url } });
    }
  });
  const instance = {
    debugger: { sendCommand, on: events.on.bind(events), removeListener: events.removeListener.bind(events) },
    loadURL,
    getURL: () => 'https://previous.example/',
  } as unknown as StorageImportTarget;
  return { instance, events, sendCommand, loadURL };
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('storage-state file reading', () => {
  it('reads a BOM-prefixed export', async () => {
    const file = await stateFile({ cookies: [], origins: [] });
    await fs.writeFile(file, '\uFEFF{"cookies":[]}');
    expect(await readStorageStateFile(file)).toEqual({ cookies: [] });
  });

  it('returns a credential-free error for invalid JSON', async () => {
    const file = await stateFile({});
    await fs.writeFile(file, '{"token":"private-credential"');
    await expect(readStorageStateFile(file)).rejects.toThrow('Storage-state file must contain valid JSON.');
  });

  it('rejects oversized exports', async () => {
    const file = await stateFile({});
    await fs.writeFile(file, Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(readStorageStateFile(file)).rejects.toThrow(/10 MB/);
  });
});

describe('persistent browser state import', () => {
  it('validates every entry before modifying existing cookies', async () => {
    const file = await stateFile({
      cookies: [{ name: 'session', value: 'secret', domain: 'example.com' }],
      origins: [{ origin: 'file:///invalid', localStorage: [] }],
    });
    const setCookie = vi.fn();
    await expect(
      importBrowserStorageState(file, undefined, { setCookie, flush: vi.fn(), target: target().instance })
    ).rejects.toThrow();
    expect(setCookie).not.toHaveBeenCalled();
  });

  it('imports HttpOnly cookies and restores the prior page after per-origin Local Storage writes', async () => {
    const file = await stateFile({
      cookies: [{ name: 'session', value: 'secret', domain: 'example.com', httpOnly: true, expires: -1 }],
      origins: [{ origin: 'https://example.com:8443', localStorage: [{ name: 'auth', value: 'secret' }] }],
    });
    const page = target();
    const setCookie = vi.fn(async () => undefined);
    const flush = vi.fn(async () => undefined);
    const result = await importBrowserStorageState(file, undefined, { setCookie, flush, target: page.instance });
    expect(setCookie).toHaveBeenCalledWith(expect.objectContaining({ httpOnly: true, name: 'session' }));
    expect(result).toMatchObject({ cookiesImported: 1, localStorageImported: 1, originsImported: 1, failures: [] });
    expect(page.loadURL).toHaveBeenLastCalledWith('https://previous.example/');
  });

  it('reports rejected cookies without exposing raw browser errors or credential values', async () => {
    const file = await stateFile([{ name: 'session', value: 'secret', domain: 'example.com' }]);
    const result = await importBrowserStorageState(file, undefined, {
      setCookie: vi.fn(async () => {
        throw new Error('secret');
      }),
      flush: vi.fn(async () => undefined),
      target: target().instance,
    });
    expect(result.cookiesImported).toBe(0);
    expect(result.failures).toEqual([{ kind: 'cookie', index: 0, message: 'Cookie was rejected by the browser.' }]);
  });

  it('stops interception and removes listeners when storage evaluation fails', async () => {
    const page = target();
    page.sendCommand.mockImplementation(async (method) =>
      method === 'Runtime.evaluate' ? { exceptionDetails: {} } : {}
    );
    await expect(
      restoreOriginStorage(page.instance, {
        origin: 'https://example.com',
        entries: [{ name: 'auth', value: 'secret' }],
      })
    ).rejects.toThrow(/could not be restored/);
    expect(page.sendCommand).toHaveBeenCalledWith('Fetch.disable');
    expect(page.sendCommand).toHaveBeenLastCalledWith('Network.setBypassServiceWorker', { bypass: false });
    expect(page.events.listenerCount('message')).toBe(0);
  });

  it('bypasses site service workers until Local Storage restoration has finished', async () => {
    const page = target();
    await restoreOriginStorage(page.instance, { origin: 'https://example.com', entries: [] });
    const methods = page.sendCommand.mock.calls.map(([method]) => method);
    expect(page.sendCommand.mock.calls[0]).toEqual(['Network.setBypassServiceWorker', { bypass: true }]);
    expect(methods.indexOf('Fetch.enable')).toBeLessThan(methods.indexOf('Runtime.evaluate'));
    expect(page.sendCommand).toHaveBeenLastCalledWith('Network.setBypassServiceWorker', { bypass: false });
  });

  it('fulfills only the synthetic document on the exact target origin', async () => {
    const page = target();
    await restoreOriginStorage(page.instance, { origin: 'https://example.com:8443', entries: [] });
    expect(page.loadURL.mock.calls[0][0]).toMatch(/^https:\/\/example\.com:8443\/__aionui_storage_import__/);
    expect(page.sendCommand).toHaveBeenCalledWith(
      'Fetch.fulfillRequest',
      expect.objectContaining({ responseCode: 200 })
    );
  });
});
