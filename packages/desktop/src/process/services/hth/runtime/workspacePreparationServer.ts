/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';

type WorkspacePreparationRequest = {
  conversationId: string;
  workspace: string;
};

type PreparationConnection = { pipe: string; token: string };

/** Waitable local IPC used by managed CLIs before they read project configuration. */
export class HTHWorkspacePreparationServer {
  private server?: net.Server;
  private directory?: string;
  private starting?: Promise<PreparationConnection>;
  private readonly sockets = new Set<net.Socket>();
  private readonly pendingByWorkspace = new Map<string, Promise<void>>();

  constructor(private readonly prepare: (request: WorkspacePreparationRequest) => Promise<void>) {}

  start(): Promise<PreparationConnection> {
    this.starting ??= this.listen().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private async listen(): Promise<PreparationConnection> {
    let pipe: string;
    if (process.platform === 'win32') {
      pipe = `\\\\.\\pipe\\hqbuddy-workspace-${randomUUID()}`;
    } else {
      this.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hqbuddy-workspace-'));
      await fs.chmod(this.directory, 0o700);
      pipe = path.join(this.directory, 'prepare.sock');
    }
    const connection = { pipe, token: randomBytes(32).toString('hex') };
    const server = net.createServer((socket) => this.accept(socket, connection.token));
    server.maxConnections = 32;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(pipe, () => {
          server.off('error', reject);
          resolve();
        });
      });
      if (process.platform !== 'win32') await fs.chmod(pipe, 0o600);
    } catch (error) {
      await this.close();
      throw error;
    }
    server.on('error', () => console.error('[HTHWorkspacePreparation] Local preparation channel failed'));
    server.unref();
    return connection;
  }

  private accept(socket: net.Socket, token: string): void {
    this.sockets.add(socket);
    socket.unref();
    const deadline = setTimeout(() => socket.destroy(), 35_000);
    deadline.unref();
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      clearTimeout(deadline);
      this.sockets.delete(socket);
    });
    let buffer = '';
    let received = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (received) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16_384) {
        received = true;
        socket.end('{"ok":false}\n');
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      received = true;
      socket.pause();
      let request: unknown;
      try {
        request = JSON.parse(buffer.slice(0, end));
      } catch {
        socket.end('{"ok":false}\n');
        return;
      }
      if (
        !request ||
        typeof request !== 'object' ||
        !('token' in request) ||
        typeof request.token !== 'string' ||
        !/^[a-f0-9]{64}$/.test(request.token) ||
        request.token.length !== token.length ||
        !timingSafeEqual(Buffer.from(request.token), Buffer.from(token)) ||
        !('conversationId' in request) ||
        typeof request.conversationId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(request.conversationId) ||
        !('workspace' in request) ||
        typeof request.workspace !== 'string' ||
        !path.isAbsolute(request.workspace) ||
        request.workspace.includes('\0')
      ) {
        socket.end('{"ok":false}\n');
        return;
      }
      const validated = { conversationId: request.conversationId, workspace: request.workspace };
      const key = process.platform === 'win32' ? path.resolve(validated.workspace).toLowerCase() : validated.workspace;
      // Conversations may share a workspace; serialize preparation without skipping identity checks.
      const previous = this.pendingByWorkspace.get(key) ?? Promise.resolve();
      const preparation = previous.catch(() => {}).then(() => this.prepare(validated));
      this.pendingByWorkspace.set(key, preparation);
      void preparation
        .then(() => {
          socket.end('{"ok":true}\n');
        })
        .catch(() => {
          console.warn('[HTHWorkspacePreparation] Project preparation failed', {
            conversationId: validated.conversationId,
          });
          socket.end('{"ok":false}\n');
        })
        .finally(() => {
          if (this.pendingByWorkspace.get(key) === preparation) this.pendingByWorkspace.delete(key);
        });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.directory) {
      await fs.rm(this.directory, { recursive: true, force: true });
      this.directory = undefined;
    }
  }
}
