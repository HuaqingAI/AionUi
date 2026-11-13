/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** A request to create or select the browser view for an agent operation. */
export type BrowserOpenRequest = {
  requestId: string;
  conversationId?: string;
  workspace?: string;
  url?: string;
};

/** A browser view acknowledges only the request it has actually rendered. */
export type BrowserWebContentsReport = {
  webContentsId: number;
  requestId?: string;
};

export type BrowserOpenFailure = {
  requestId: string;
  error: string;
};
