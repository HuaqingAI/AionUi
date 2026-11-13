/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { session, webContents } from 'electron';
import { ipcBridge } from '@/common';
import { BROWSER_SESSION_PARTITION, BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';
import type { ISessionMcpServer } from '@/common/config/storage';
import { getBuiltinMcpScriptPath } from '@process/utils/initStorage';
import { cdpStartupEnabled, setActiveCdpPort } from '@process/utils/configureChromium';
import { startCdpBridge, type CdpBridgeHandle } from '../cdpBridge';
import {
  BROWSER_CONTROL_MAX_MESSAGE_BYTES,
  BROWSER_CONTROL_IMPORT_TIMEOUT_MS,
  BROWSER_CONTROL_PIPE_ENV,
  BROWSER_CONTROL_TIMEOUT_MS,
  BROWSER_CONTROL_TOKEN_ENV,
  type BrowserControlRequest,
  type BrowserControlResponse,
  type BrowserOpenRequest,
} from './controlProtocol';
import { importBrowserStorageState } from './storageImport';

type PendingView = {
  resolve: (id: number) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type BrowserControlDependencies = {
  startBridge: () => Promise<CdpBridgeHandle>;
  requestView: (request: BrowserOpenRequest) => void;
  getScriptPath: () => string;
};

const validUrl = (value: unknown): value is string => {
  if (value === 'about:blank') return true;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
};

const isRequest = (value: unknown): value is BrowserControlRequest => {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.token === 'string' &&
    ['ensure', 'open', 'importState'].includes(String(candidate.method)) &&
    (candidate.conversationId === undefined ||
      (typeof candidate.conversationId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(candidate.conversationId))) &&
    (candidate.workspace === undefined ||
      (typeof candidate.workspace === 'string' &&
        path.isAbsolute(candidate.workspace) &&
        !candidate.workspace.includes('\0'))) &&
    (candidate.url === undefined || validUrl(candidate.url)) &&
    (candidate.filePath === undefined ||
      (typeof candidate.filePath === 'string' &&
        path.isAbsolute(candidate.filePath) &&
        !candidate.filePath.includes('\0'))) &&
    (candidate.origin === undefined || typeof candidate.origin === 'string')
  );
};

/** Connect standard MCP child processes to the visible in-app browser without involving AionCore APIs. */
export class BrowserControlService {
  private bridge?: CdpBridgeHandle;
  private server?: net.Server;
  private directory?: string;
  private starting?: Promise<void>;
  private token?: string;
  private targetGeneration = 0;
  private readonly sockets = new Set<net.Socket>();
  private readonly pendingViews = new Map<string, PendingView>();
  private operation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dependencies: BrowserControlDependencies = {
      startBridge: startCdpBridge,
      requestView: (request) => void ipcBridge.application.browserOpenRequested.emit(request),
      getScriptPath: () => getBuiltinMcpScriptPath('builtin-mcp-browser'),
    }
  ) {}

  /** Start both local channels before the backend takes its environment snapshot. */
  start(): Promise<void> {
    if (!cdpStartupEnabled) return Promise.resolve();
    this.starting ??= this.listen().catch(async (error: unknown) => {
      await this.close();
      throw error;
    });
    return this.starting;
  }

  /** Return a stable session snapshot; volatile connection credentials travel only through process inheritance. */
  getSessionMcpServer(): ISessionMcpServer | null {
    if (!this.bridge || !this.server?.listening) return null;
    return {
      id: BUILTIN_BROWSER_MCP_NAME,
      name: BUILTIN_BROWSER_MCP_NAME,
      transport: { type: 'stdio', command: 'node', args: [this.dependencies.getScriptPath()] },
    };
  }

  private async listen(): Promise<void> {
    this.bridge = await this.dependencies.startBridge();
    const token = randomBytes(32).toString('hex');
    let pipe: string;
    if (process.platform === 'win32') {
      pipe = `\\\\.\\pipe\\aionui-browser-${randomUUID()}`;
    } else {
      this.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aionui-browser-'));
      await fs.chmod(this.directory, 0o700);
      pipe = path.join(this.directory, 'control.sock');
    }
    this.token = token;
    const server = net.createServer((socket) => this.accept(socket));
    server.maxConnections = 32;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipe, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') await fs.chmod(pipe, 0o600);
    server.on('error', () => console.warn('[BrowserControl] Local control channel failed.'));
    server.unref();
    setActiveCdpPort(this.bridge.port);
    process.env.AIONUI_CDP_ACTIVE_PORT = String(this.bridge.port);
    process.env.AIONUI_CDP_BRIDGE_TOKEN = this.bridge.token;
    process.env[BROWSER_CONTROL_PIPE_ENV] = pipe;
    process.env[BROWSER_CONTROL_TOKEN_ENV] = token;
  }

  /** Attach only the browser partition and acknowledge the exact request that created or selected it. */
  reportView(webContentsId: number, requestId?: string): { success: boolean; msg?: string } {
    if (!this.bridge) return { success: false, msg: 'In-app browser control is disabled or unavailable.' };
    if (!Number.isInteger(webContentsId) || webContentsId <= 0)
      return { success: false, msg: 'A valid browser webContents identifier is required.' };
    const contents = webContents.fromId(webContentsId);
    if (
      !contents ||
      contents.isDestroyed() ||
      contents.getType() !== 'webview' ||
      contents.session !== session.fromPartition(BROWSER_SESSION_PARTITION)
    ) {
      return { success: false, msg: 'Refusing to attach: only the in-app browser webview may be controlled.' };
    }
    // Ignore delayed reports from a view request that has already been superseded or timed out.
    if (requestId && !this.pendingViews.has(requestId)) return { success: true };
    const previousId = this.bridge.attachedWebContentsId();
    const attached = this.bridge.attach(webContentsId);
    if (attached.ok === false) {
      if (requestId) this.failView(requestId, 'The in-app browser page could not be attached.');
      return { success: false, msg: attached.reason };
    }
    if (previousId !== webContentsId) this.targetGeneration += 1;
    if (requestId) {
      const pending = this.pendingViews.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingViews.delete(requestId);
        pending.resolve(webContentsId);
      }
    }
    return { success: true };
  }

  /** Reject a pending view operation when the renderer cannot display its conversation. */
  failView(requestId: string, _error?: string): void {
    const pending = this.pendingViews.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingViews.delete(requestId);
    pending.reject(new Error('The in-app browser view could not be opened.'));
  }

  private async ensureView(request: BrowserControlRequest): Promise<number> {
    if (!this.bridge) throw new Error('In-app browser control is unavailable.');
    const requestId = randomUUID();
    const ready = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingViews.delete(requestId);
        reject(new Error('Opening the in-app browser timed out. Bring AionUi to the foreground and retry.'));
      }, BROWSER_CONTROL_TIMEOUT_MS - 1_000);
      timeout.unref();
      this.pendingViews.set(requestId, { resolve, reject, timeout });
    });
    try {
      this.dependencies.requestView({
        requestId,
        conversationId: request.conversationId,
        workspace: request.workspace,
      });
    } catch {
      this.failView(requestId);
    }
    return ready;
  }

  private async execute(request: BrowserControlRequest): Promise<unknown> {
    const id = await this.ensureView(request);
    const contents = webContents.fromId(id);
    if (!contents || contents.isDestroyed()) throw new Error('The in-app browser page was closed.');
    if (request.method === 'open' && request.url) {
      try {
        await contents.loadURL(request.url);
      } catch {
        throw new Error('The requested page could not be loaded in the in-app browser.');
      }
    }
    if (request.method !== 'importState')
      return { url: contents.getURL(), ready: true, webContentsId: id, targetGeneration: this.targetGeneration };
    if (!request.filePath) throw new Error('A local storage-state file path is required.');
    const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
    return importBrowserStorageState(request.filePath, request.origin, {
      target: contents,
      setCookie: (cookie) => browserSession.cookies.set(cookie),
      flush: async () => {
        browserSession.flushStorageData();
        await browserSession.cookies.flushStore();
      },
    });
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.unref();
    socket.setEncoding('utf8');
    let timeout = setTimeout(() => socket.destroy(), BROWSER_CONTROL_TIMEOUT_MS + 1_000);
    timeout.unref();
    socket.once('close', () => {
      clearTimeout(timeout);
      this.sockets.delete(socket);
    });
    socket.on('error', () => socket.destroy());
    let buffer = '';
    let handled = false;
    const reply = (response: BrowserControlResponse): void => {
      if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
    };
    socket.on('data', (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > BROWSER_CONTROL_MAX_MESSAGE_BYTES) {
        handled = true;
        reply({ ok: false, error: 'Browser control request is too large.' });
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      handled = true;
      let request: unknown;
      try {
        request = JSON.parse(buffer.slice(0, end));
      } catch {
        reply({ ok: false, error: 'Invalid browser control request.' });
        return;
      }
      if (
        !isRequest(request) ||
        !this.token ||
        !/^[a-f0-9]{64}$/.test(request.token) ||
        request.token.length !== this.token.length ||
        !timingSafeEqual(Buffer.from(request.token), Buffer.from(this.token))
      ) {
        reply({ ok: false, error: 'Browser control request was rejected.' });
        return;
      }
      const validated = request;
      if (validated.method === 'importState') {
        clearTimeout(timeout);
        timeout = setTimeout(() => socket.destroy(), BROWSER_CONTROL_IMPORT_TIMEOUT_MS + 1_000);
        timeout.unref();
      }
      const operation = this.operation.catch((): undefined => undefined).then(() => this.execute(validated));
      this.operation = operation;
      void operation.then(
        (result) => reply({ ok: true, result }),
        (error: unknown) =>
          reply({ ok: false, error: error instanceof Error ? error.message : 'Browser operation failed.' })
      );
    });
  }

  /** Close pending operations and remove volatile credentials when the desktop process exits. */
  async close(): Promise<void> {
    for (const id of this.pendingViews.keys()) this.failView(id);
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    const bridge = this.bridge;
    this.bridge = undefined;
    await bridge?.close();
    if (this.directory) await fs.rm(this.directory, { recursive: true, force: true });
    this.directory = undefined;
    this.starting = undefined;
    this.token = undefined;
    setActiveCdpPort(null);
    delete process.env.AIONUI_CDP_ACTIVE_PORT;
    delete process.env.AIONUI_CDP_BRIDGE_TOKEN;
    delete process.env[BROWSER_CONTROL_PIPE_ENV];
    delete process.env[BROWSER_CONTROL_TOKEN_ENV];
  }
}

export const browserControlService = new BrowserControlService();
