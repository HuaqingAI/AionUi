/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import net from 'node:net';
import {
  BROWSER_CONTROL_MAX_MESSAGE_BYTES,
  BROWSER_CONTROL_IMPORT_TIMEOUT_MS,
  BROWSER_CONTROL_PIPE_ENV,
  BROWSER_CONTROL_TIMEOUT_MS,
  BROWSER_CONTROL_TOKEN_ENV,
  type BrowserControlRequest,
  type BrowserControlResponse,
} from './controlProtocol';

export type BrowserControlCommand = Omit<BrowserControlRequest, 'token'>;

type BrowserControlClientOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

/** Send one authenticated request to this application's browser controller. */
export function requestBrowserControl(
  command: BrowserControlCommand,
  { env = process.env, timeoutMs }: BrowserControlClientOptions = {}
): Promise<unknown> {
  const pipe = env[BROWSER_CONTROL_PIPE_ENV]?.trim();
  const token = env[BROWSER_CONTROL_TOKEN_ENV]?.trim();
  if (!pipe || !token) {
    return Promise.reject(
      new Error('In-app browser control is unavailable. Enable it in Settings and restart AionUi.')
    );
  }

  const request = JSON.stringify({ ...command, token }) + '\n';
  if (Buffer.byteLength(request) > BROWSER_CONTROL_MAX_MESSAGE_BYTES) {
    return Promise.reject(new Error('The browser control request is too large.'));
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let response = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const requestTimeout =
      timeoutMs ?? (command.method === 'importState' ? BROWSER_CONTROL_IMPORT_TIMEOUT_MS : BROWSER_CONTROL_TIMEOUT_MS);
    const timeout = setTimeout(
      () => finish(new Error('The in-app browser control request timed out.')),
      requestTimeout
    );

    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (response.length + chunk.length > BROWSER_CONTROL_MAX_MESSAGE_BYTES) {
        finish(new Error('The browser control response is too large.'));
        return;
      }
      response = Buffer.concat([response, chunk]);
      const newline = response.indexOf(10);
      if (newline === -1) return;

      let message: BrowserControlResponse;
      try {
        const parsed: unknown = JSON.parse(response.subarray(0, newline).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || !('ok' in parsed) || typeof parsed.ok !== 'boolean') {
          throw new Error('Invalid response');
        }
        if (!parsed.ok && (!('error' in parsed) || typeof parsed.error !== 'string')) {
          throw new Error('Invalid response');
        }
        message = parsed as BrowserControlResponse;
      } catch {
        finish(new Error('The browser controller returned an invalid response.'));
        return;
      }
      if (message.ok === false) finish(new Error(message.error));
      else finish(undefined, message.result);
    });
    socket.once('error', () => finish(new Error('The in-app browser controller could not be reached.')));
    socket.once('close', () => finish(new Error('The browser controller disconnected before responding.')));
  });
}
