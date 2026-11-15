import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  importBrowserStorageState,
  readStorageStateFile,
  restoreOriginStorage,
  setBrowserCookie,
  type StorageImportTarget,
} from '@/process/resources/builtinMcp/browser/storageImport';
import { parseBrowserStorageState } from '@/process/resources/builtinMcp/browser/storageState';

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
  const sendCommand = vi.fn(
    async (method: string, _params?: Record<string, unknown>): Promise<unknown> =>
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
    expect(result.failures).toEqual([
      { kind: 'cookie', index: 0, code: 'COOKIE_REJECTED', message: 'Cookie was rejected by the browser.' },
    ]);
  });

  it('reports a recognized browser rejection without echoing the raw error', async () => {
    const file = await stateFile([{ name: 'session', value: 'private-credential', domain: 'example.com' }]);
    const result = await importBrowserStorageState(file, undefined, {
      setCookie: vi.fn(async () => {
        throw new Error('Failed to set cookie: private-credential EXCLUDE_OVERWRITE_HTTP_ONLY');
      }),
      flush: vi.fn(async () => undefined),
      target: target().instance,
    });
    expect(result.failures[0]).toMatchObject({ code: 'COOKIE_HTTP_ONLY_CONFLICT' });
    expect(JSON.stringify(result)).not.toContain('private-credential');
  });

  it('does not count a rejected CDP cookie as imported and continues with later cookies', async () => {
    const file = await stateFile([
      { name: 'rejected', value: 'secret', domain: 'example.com' },
      { name: 'accepted', value: 'secret', domain: 'example.com' },
    ]);
    const page = target();
    page.sendCommand.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true });
    const result = await importBrowserStorageState(file, undefined, {
      setCookie: (cookie) => setBrowserCookie(page.instance, cookie),
      flush: vi.fn(async () => undefined),
      target: page.instance,
    });
    expect(result).toMatchObject({ cookiesImported: 1, failures: [{ index: 0, code: 'COOKIE_REJECTED' }] });
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
    ).rejects.toMatchObject({ code: 'LOCAL_STORAGE_WRITE_FAILED' });
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

  it('distinguishes document preparation failures from Local Storage write failures', async () => {
    const file = await stateFile({ origins: [{ origin: 'https://example.com', localStorage: [] }] });
    const page = target();
    page.loadURL.mockRejectedValueOnce(new Error('Navigation failed with private-credential'));
    const result = await importBrowserStorageState(file, undefined, {
      setCookie: vi.fn(),
      flush: vi.fn(async () => undefined),
      target: page.instance,
    });
    expect(result).toMatchObject({ originsImported: 0, failures: [{ code: 'STORAGE_DOCUMENT_FAILED' }] });
    expect(JSON.stringify(result)).not.toContain('private-credential');
  });

  it('reports a disconnected debugger without exposing command details', async () => {
    const file = await stateFile({ origins: [{ origin: 'https://example.com', localStorage: [] }] });
    const page = target();
    page.sendCommand.mockRejectedValue(new Error('Debugger is not attached: private-credential'));
    const result = await importBrowserStorageState(file, undefined, {
      setCookie: vi.fn(),
      flush: vi.fn(async () => undefined),
      target: page.instance,
    });
    expect(result.failures[0]).toMatchObject({ kind: 'origin', code: 'BROWSER_CONNECTION_LOST' });
    expect(JSON.stringify(result)).not.toContain('private-credential');
  });

  it('identifies aborted storage navigation without exposing the failing URL', async () => {
    const file = await stateFile({ origins: [{ origin: 'https://example.com', localStorage: [] }] });
    const page = target();
    page.loadURL.mockRejectedValueOnce(
      Object.assign(new Error('Navigation failed: private-credential'), { errno: -3 })
    );
    const result = await importBrowserStorageState(file, undefined, {
      setCookie: vi.fn(),
      flush: vi.fn(async () => undefined),
      target: page.instance,
    });
    expect(result.failures[0]).toMatchObject({ kind: 'origin', code: 'STORAGE_NAVIGATION_ABORTED' });
    expect(JSON.stringify(result)).not.toContain('private-credential');
  });

  it('keeps Local Storage protocol errors in the origin failure category', async () => {
    const file = await stateFile({ origins: [{ origin: 'https://example.com', localStorage: [] }] });
    const page = target();
    page.sendCommand.mockImplementation(async (method) => {
      if (method === 'Runtime.evaluate') throw new Error('Invalid parameters: private-credential');
      return {};
    });
    const result = await importBrowserStorageState(file, undefined, {
      setCookie: vi.fn(),
      flush: vi.fn(async () => undefined),
      target: page.instance,
    });
    expect(result.failures[0]).toMatchObject({ kind: 'origin', code: 'LOCAL_STORAGE_WRITE_FAILED' });
    expect(JSON.stringify(result)).not.toContain('private-credential');
  });

  it('times out preparation and removes interception listeners', async () => {
    vi.useFakeTimers();
    try {
      const page = target();
      page.loadURL.mockImplementationOnce(() => new Promise(() => {}));
      const restored = expect(
        restoreOriginStorage(page.instance, { origin: 'https://example.com', entries: [] })
      ).rejects.toMatchObject({ code: 'STORAGE_DOCUMENT_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10_000);
      await restored;
      expect(page.events.listenerCount('message')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CDP cookie import', () => {
  it('preserves a host-only session cookie and its exported non-HttpOnly attribute', async () => {
    const page = target();
    page.sendCommand.mockResolvedValueOnce({ success: true });
    const { cookies } = parseBrowserStorageState([
      {
        name: 'session',
        value: 'credential',
        domain: 'example.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
        expires: -1,
      },
    ]);
    await setBrowserCookie(page.instance, cookies[0]);
    expect(page.sendCommand).toHaveBeenCalledExactlyOnceWith('Network.setCookie', {
      url: 'https://example.com/',
      name: 'session',
      value: 'credential',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'Lax',
    });
  });

  it('preserves domain scope, HttpOnly, persistent expiry and SameSite=None', async () => {
    const page = target();
    page.sendCommand.mockResolvedValueOnce({ success: true });
    const { cookies } = parseBrowserStorageState(
      [
        {
          name: 'session',
          value: 'credential',
          domain: '.example.com',
          path: '/account',
          secure: true,
          httpOnly: true,
          sameSite: 'None',
          expires: 110,
        },
      ],
      undefined,
      100
    );
    await setBrowserCookie(page.instance, cookies[0]);
    expect(page.sendCommand).toHaveBeenCalledExactlyOnceWith('Network.setCookie', {
      url: 'https://example.com/account',
      name: 'session',
      value: 'credential',
      domain: '.example.com',
      path: '/account',
      secure: true,
      httpOnly: true,
      sameSite: 'None',
      expires: 110,
    });
  });

  it('leaves an unspecified SameSite attribute unspecified', async () => {
    const page = target();
    page.sendCommand.mockResolvedValueOnce({ success: true });
    const { cookies } = parseBrowserStorageState([{ name: 'session', value: 'credential', domain: 'example.com' }]);
    await setBrowserCookie(page.instance, cookies[0]);
    expect(page.sendCommand.mock.calls[0]).toEqual([
      'Network.setCookie',
      expect.not.objectContaining({ sameSite: expect.anything() }),
    ]);
  });

  it('rejects a missing browser acknowledgement', async () => {
    const page = target();
    const { cookies } = parseBrowserStorageState([{ name: 'session', value: 'credential', domain: 'example.com' }]);
    await expect(setBrowserCookie(page.instance, cookies[0])).rejects.toMatchObject({ code: 'COOKIE_REJECTED' });
  });

  it('redacts credentials from rejected protocol commands while retaining a known category', async () => {
    const page = target();
    page.sendCommand.mockRejectedValueOnce(new Error('Invalid cookie fields: private-credential'));
    const { cookies } = parseBrowserStorageState([{ name: 'session', value: 'credential', domain: 'example.com' }]);
    await expect(setBrowserCookie(page.instance, cookies[0])).rejects.toMatchObject({
      code: 'COOKIE_INVALID_PARAMETERS',
      message: 'COOKIE_INVALID_PARAMETERS',
    });
  });
});
