#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrowserMcpProxy, createBrowserMcpServer } from './browser/mcpProxy';

const proxy = new BrowserMcpProxy();
const server = createBrowserMcpServer(proxy);
let closing = false;

const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await proxy.close();
  await server.close();
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, () => {
    void close().finally(() => process.exit(0));
  });
}
process.stdin.once('end', () => void close());
process.stdin.once('close', () => void close());

void server.connect(new StdioServerTransport()).catch(async () => {
  process.stderr.write('[builtin-mcp-browser] Could not initialize the browser MCP protocol.\n');
  await close();
  process.exitCode = 1;
});
