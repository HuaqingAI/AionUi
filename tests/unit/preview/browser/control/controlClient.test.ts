import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  BROWSER_CONTROL_MAX_MESSAGE_BYTES,
  BROWSER_CONTROL_PIPE_ENV,
  BROWSER_CONTROL_TOKEN_ENV,
} from '@/process/resources/builtinMcp/browser/controlProtocol';
import { requestBrowserControl } from '@/process/resources/builtinMcp/browser/controlClient';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

const listen = async (accept: (socket: net.Socket) => void) => {
  const pipe =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\aionui-browser-client-test-${randomUUID()}`
      : path.join(os.tmpdir(), `browser-client-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    accept(socket);
  });
  await new Promise<void>((resolve) => server.listen(pipe, resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { env: { [BROWSER_CONTROL_PIPE_ENV]: pipe, [BROWSER_CONTROL_TOKEN_ENV]: 'test-token' } };
};

describe('browser controller client', () => {
  it('authenticates against the inherited instance and accepts a fragmented response', async () => {
    let token: string | undefined;
    const options = await listen((socket) =>
      socket.once('data', (data) => {
        token = (JSON.parse(data.toString()) as { token: string }).token;
        socket.write('{"ok":true,"res');
        socket.end('ult":{"attached":true}}\n');
      })
    );
    expect(await requestBrowserControl({ method: 'ensure' }, options)).toEqual({ attached: true });
    expect(token).toBe('test-token');
  });

  it('refuses to guess a controller if the instance credentials are missing', async () => {
    await expect(requestBrowserControl({ method: 'open' }, { env: {} })).rejects.toThrow('unavailable');
  });

  it('surfaces a controller rejection', async () => {
    const options = await listen((socket) =>
      socket.once('data', () => socket.end('{"ok":false,"error":"Browser is disabled."}\n'))
    );
    await expect(requestBrowserControl({ method: 'ensure' }, options)).rejects.toThrow('Browser is disabled.');
  });

  it('rejects malformed replies instead of treating them as success', async () => {
    const options = await listen((socket) => socket.once('data', () => socket.end('{"ok":false}\n')));
    await expect(requestBrowserControl({ method: 'ensure' }, options)).rejects.toThrow('invalid response');
  });

  it('bounds response size', async () => {
    const options = await listen((socket) =>
      socket.once('data', () => socket.end('x'.repeat(BROWSER_CONTROL_MAX_MESSAGE_BYTES + 1)))
    );
    await expect(requestBrowserControl({ method: 'ensure' }, options)).rejects.toThrow('too large');
  });

  it('times out rather than leaving a disconnected browser action pending forever', async () => {
    const options = await listen(() => {});
    await expect(requestBrowserControl({ method: 'ensure' }, { ...options, timeoutMs: 30 })).rejects.toThrow(
      'timed out'
    );
  });

  it('reports an early connection close', async () => {
    const options = await listen((socket) => socket.end());
    await expect(requestBrowserControl({ method: 'ensure' }, options)).rejects.toThrow('disconnected');
  });
});
