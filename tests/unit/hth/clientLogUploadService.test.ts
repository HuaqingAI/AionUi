/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => 'C:\\default-logs',
    getVersion: () => '0.0.0-test',
  },
}));

import { HTHClientLogUploadService } from '@/process/services/hth/client/clientLogUploadService';
import type { HTHAuthService } from '@/process/services/hth/authService';

const LOG_ROOT = 'C:\\sandbox\\logs';
const LOG_DATE = '2026-09-10';

type FileSpec = Record<string, string>;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('HTHClientLogUploadService', () => {
  it('uploads every direct regular file in lexical order with the desktop token and runtime version', async () => {
    const fetchMock = vi.fn(async () => response({ file_count: 3, total_bytes: 8 }));
    const service = createService({
      files: {
        'trace.json': '{}',
        '2026-09-10.aioncore.log': 'core',
        '2026-09-10.log': 'log',
      },
      extraEntries: ['nested', 'linked'],
      fetch: fetchMock,
    });

    await expect(service.upload({ date: LOG_DATE })).resolves.toEqual({
      outcome: 'uploaded',
      date: LOG_DATE,
      fileCount: 3,
      totalBytes: 8,
    });

    const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://api.example.com/api/aionui/client-logs/2026-09-10');
    expect(request.headers).toEqual({
      Authorization: 'Bearer desktop-token',
      'X-AionUI-Client-Version': '1.2.3',
    });
    expect((request.body as FormData).getAll('files').map((file) => (file as File).name)).toEqual([
      '2026-09-10.aioncore.log',
      '2026-09-10.log',
      'trace.json',
    ]);
  });

  it.each([
    ['missing date directory', { directory: 'missing' as const }],
    ['symlinked date directory', { directory: 'symlink' as const }],
    ['empty date directory', { directory: 'directory' as const, files: {} }],
  ])('does not send a request when the %s has no regular files', async (_name, input) => {
    const fetchMock = vi.fn();
    const service = createService({ ...input, fetch: fetchMock });

    await expect(service.upload({ date: LOG_DATE })).resolves.toEqual({ outcome: 'no-files', date: LOG_DATE });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses local calendar components for the dated directory and rejects future dates', async () => {
    const pathCalls: string[] = [];
    const fileSystem = {
      lstat: vi.fn(async (filePath: string) => {
        pathCalls.push(filePath);
        return regularDirectory();
      }),
      readdir: vi.fn(async () => []),
      readFile: vi.fn(),
    };
    const service = createService({ fileSystem, now: () => new Date(2026, 8, 10) });

    await service.upload({ date: LOG_DATE });
    await expect(service.upload({ date: '2026-09-11' })).resolves.toMatchObject({
      outcome: 'failed',
      code: 'invalid-date',
    });

    expect(pathCalls[0]).toBe('C:\\sandbox\\logs\\2026\\09\\10');
    expect(fileSystem.lstat).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an oversized file', { files: { 'large.log': 'x' }, sizes: { 'large.log': 20 * 1024 * 1024 + 1 } }],
    ['a read failure', { files: { 'read-error.log': 'content' }, readError: true }],
  ])('keeps the batch local when there is %s', async (_name, input) => {
    const fetchMock = vi.fn();
    const service = createService({ ...input, fetch: fetchMock });

    await expect(service.upload({ date: LOG_DATE })).resolves.toMatchObject({
      outcome: 'failed',
      code: 'local-limit',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, { outcome: 'not-logged-in' }],
    [403, { outcome: 'not-logged-in' }],
    [413, { outcome: 'failed', code: 'server-rejected' }],
    [500, { outcome: 'failed', code: 'server' }],
  ])('maps HTTP %i to a safe upload outcome', async (status, expected) => {
    const service = createService({ fetch: vi.fn(async () => new Response(null, { status })) });

    await expect(service.upload({ date: LOG_DATE })).resolves.toMatchObject(expected);
  });

  it('reports rate limiting with the server retry interval', async () => {
    const service = createService({
      fetch: vi.fn(async () => new Response(null, { status: 429, headers: { 'Retry-After': '75' } })),
    });

    await expect(service.upload({ date: LOG_DATE })).resolves.toEqual({
      outcome: 'failed',
      date: LOG_DATE,
      code: 'rate-limited',
      retryAfterSeconds: 75,
    });
  });

  it('reports an aborted request as a network failure without exposing the token', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_url: URL, request: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          (request.signal as AbortSignal).addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    );
    const service = createService({ fetch: fetchMock });

    const upload = service.upload({ date: LOG_DATE });
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(upload).resolves.toEqual({ outcome: 'failed', date: LOG_DATE, code: 'network' });
    expect(JSON.stringify(await upload)).not.toContain('desktop-token');
  });
});

function createService({
  directory = 'directory',
  extraEntries = [],
  fetch = vi.fn(async () => response({ file_count: 1, total_bytes: 7 })),
  fileSystem,
  files = { '2026-09-10.log': 'content' },
  now = () => new Date(2026, 8, 10),
  readError = false,
  sizes = {},
}: {
  directory?: 'directory' | 'missing' | 'symlink';
  extraEntries?: string[];
  fetch?: typeof globalThis.fetch;
  fileSystem?: {
    lstat: ReturnType<typeof vi.fn>;
    readdir: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
  };
  files?: FileSpec;
  now?: () => Date;
  readError?: boolean;
  sizes?: Record<string, number>;
} = {}): HTHClientLogUploadService {
  const logDirectory = `${LOG_ROOT}\\2026\\09\\10`;
  const localFileSystem =
    fileSystem ??
    ({
      lstat: vi.fn(async (filePath: string) => {
        if (filePath === logDirectory) {
          if (directory === 'missing') {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          return directory === 'symlink' ? symbolicDirectory() : regularDirectory();
        }
        const name = filePath.slice(logDirectory.length + 1);
        if (extraEntries.includes(name)) {
          return name === 'linked' ? symbolicFile() : regularDirectory();
        }
        return regularFile(sizes[name] ?? Buffer.byteLength(files[name]));
      }),
      readdir: vi.fn(async () => [...Object.keys(files), ...extraEntries].map((name) => ({ name }))),
      readFile: vi.fn(async (filePath: string) => {
        if (readError) {
          throw new Error('read failed');
        }
        return Buffer.from(files[filePath.slice(logDirectory.length + 1)]);
      }),
    } as const);
  const authService = {
    getDesktopUpdateAccess: vi.fn(async () => ({ baseUrl: 'https://api.example.com/', token: 'desktop-token' })),
  } as Pick<HTHAuthService, 'getDesktopUpdateAccess'>;

  return new HTHClientLogUploadService(authService, {
    appVersion: () => '1.2.3',
    fetch,
    fileSystem: localFileSystem as never,
    logRoot: () => LOG_ROOT,
    now,
  });
}

function response(data: { file_count: number; total_bytes: number }): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200 });
}

function regularDirectory() {
  return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
}

function symbolicDirectory() {
  return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => true };
}

function symbolicFile() {
  return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => true };
}

function regularFile(size: number) {
  return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size };
}
