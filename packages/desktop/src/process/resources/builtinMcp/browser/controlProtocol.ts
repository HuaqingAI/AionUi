/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export const BROWSER_CONTROL_PIPE_ENV = 'AIONUI_BROWSER_CONTROL_PIPE';
export const BROWSER_CONTROL_TOKEN_ENV = 'AIONUI_BROWSER_CONTROL_TOKEN';
export const BROWSER_CONTROL_TIMEOUT_MS = 30_000;
export const BROWSER_CONTROL_IMPORT_TIMEOUT_MS = 120_000;
export const BROWSER_CONTROL_MAX_MESSAGE_BYTES = 64 * 1024;

export type BrowserControlMethod = 'ensure' | 'open' | 'importState';

export type BrowserControlRequest = {
  token: string;
  method: BrowserControlMethod;
  conversationId?: string;
  workspace?: string;
  url?: string;
  filePath?: string;
  origin?: string;
};

export type BrowserControlResponse = { ok: true; result?: unknown } | { ok: false; error: string };

export type BrowserOpenRequest = {
  requestId: string;
  conversationId?: string;
  workspace?: string;
  url?: string;
};
