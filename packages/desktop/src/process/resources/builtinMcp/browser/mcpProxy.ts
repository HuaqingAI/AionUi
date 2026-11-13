/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type JSONRPCMessage,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';
import { buildMcpSpawnCommand, resolveBridgeToken, resolveBrowserUrl } from '../browserServerPort';
import { requestBrowserControl, type BrowserControlCommand } from './controlClient';

const CHROME_DEVTOOLS_MCP_VERSION = '0.16.0';
const UNSUPPORTED_TOOLS = new Set(['new_page', 'select_page', 'close_page']);
const openArguments = z.object({ url: z.string().min(1).optional() }).strict();
const importArguments = z.object({ file_path: z.string().min(1), origin: z.string().min(1).optional() }).strict();

const BROWSER_TOOLS: Tool[] = [
  {
    name: 'browser_open',
    description:
      'Open a URL in the visible AionUi in-app browser. Use this when the user asks to open a website in the application. The browser panel is created automatically; never launch a separate Chrome window.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'browser_import_storage_state',
    description:
      'Import a local Playwright storage_state.json into the AionUi in-app browser, including HttpOnly cookies and origins[].localStorage. Also accepts a cookie export array, or a Local Storage object file with an explicit origin. Pass the local file path; do not copy credentials into chat. Imported state is shared by in-app browser tabs. Local Storage and unexpired persistent cookies survive application restarts; session cookies retain their normal session lifetime.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path, or a path relative to the conversation workspace.' },
        origin: { type: 'string', description: 'Website origin for a standalone localStorage file, if needed.' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
];

/** A subprocess transport that hides Windows consoles and closes its complete process tree. */
export class BrowserToolTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private readonly readBuffer = new ReadBuffer();
  private closing?: Promise<void>;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: NodeJS.ProcessEnv,
    private readonly cwd: string
  ) {}

  async start(): Promise<void> {
    if (this.child) throw new Error('Browser tool transport already started.');
    const child = spawn(this.command, this.args, {
      env: this.env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      while (true) {
        try {
          const message = this.readBuffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error('Invalid browser tool message.'));
          break;
        }
      }
    });
    // stdout belongs to the MCP protocol; diagnostics must only use stderr.
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.stdin.on('error', (error: Error) => this.onerror?.(error));
    child.once('close', () => {
      if (this.child === child) this.child = undefined;
      this.onclose?.();
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error: Error) => {
        reject(error);
        this.onerror?.(error);
      });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const input = this.child?.stdin;
    if (!input || input.destroyed) throw new Error('The browser tool process is not connected.');
    await new Promise<void>((resolve, reject) => {
      input.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  close(): Promise<void> {
    this.closing ??= this.stop();
    return this.closing;
  }

  private async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const ended = new Promise<void>((resolve) => child.once('close', resolve));
    child.stdin.end();
    await Promise.race([ended, new Promise<void>((resolve) => setTimeout(resolve, 300))]);
    if (child.exitCode === null && child.pid !== undefined) {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.once('close', () => resolve());
          killer.once('error', () => resolve());
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
      await Promise.race([ended, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
      if (child.exitCode === null) {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          // The child may have exited between checking and signalling it.
        }
      }
    }
    this.child = undefined;
    this.readBuffer.clear();
  }
}

export type BrowserDevtoolsConnection = {
  listTools: () => Promise<Tool[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  close: () => Promise<void>;
};

/** Connect only to the CDP bridge inherited from the current application instance. */
export async function connectBrowserDevtools(env: NodeJS.ProcessEnv, cwd: string): Promise<BrowserDevtoolsConnection> {
  const browserUrl = resolveBrowserUrl({ env });
  if (!browserUrl || !resolveBridgeToken({ env })) {
    throw new Error('The in-app browser control bridge is unavailable. Enable it in Settings and restart AionUi.');
  }
  const plan = buildMcpSpawnCommand({ platform: process.platform, version: CHROME_DEVTOOLS_MCP_VERSION, browserUrl });
  const transport = new BrowserToolTransport(
    plan.command,
    plan.args,
    { ...env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
    cwd
  );
  const client = new Client({ name: BUILTIN_BROWSER_MCP_NAME, version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 30_000 });
  } catch (error) {
    await transport.close();
    throw error;
  }
  return {
    listTools: async () => (await client.listTools()).tools,
    callTool: async (name, args) =>
      CallToolResultSchema.parse(
        await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 120_000 })
      ),
    close: () => client.close(),
  };
}

type BrowserMcpProxyOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  control?: (command: BrowserControlCommand) => Promise<unknown>;
  connectDevtools?: () => Promise<BrowserDevtoolsConnection>;
  diagnostic?: (message: string) => void;
};

const toolResult = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value ?? { success: true }) }],
});

/** Keep UI creation and state import local while forwarding ordinary webpage tools. */
export class BrowserMcpProxy {
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly control: (command: BrowserControlCommand) => Promise<unknown>;
  private readonly connectDevtools: () => Promise<BrowserDevtoolsConnection>;
  private readonly diagnostic: (message: string) => void;
  private connection?: Promise<BrowserDevtoolsConnection>;
  private upstreamTools?: Tool[];
  private attachedWebContentsId?: number;
  private targetGeneration?: number;
  private pendingCall: Promise<unknown> = Promise.resolve();

  constructor(options: BrowserMcpProxyOptions = {}) {
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.control = options.control ?? ((command) => requestBrowserControl(command, { env: this.env }));
    this.connectDevtools = options.connectDevtools ?? (() => connectBrowserDevtools(this.env, this.cwd));
    this.diagnostic = options.diagnostic ?? ((message) => process.stderr.write(`[builtin-mcp-browser] ${message}\n`));
  }

  private getConnection(): Promise<BrowserDevtoolsConnection> {
    this.connection ??= this.connectDevtools().catch((error: unknown) => {
      this.connection = undefined;
      throw error;
    });
    return this.connection;
  }

  private async request(command: BrowserControlCommand): Promise<unknown> {
    const result = await this.control({
      conversationId: this.env.AIONUI_CONVERSATION_ID,
      workspace: this.cwd,
      ...command,
    });
    if (
      result !== null &&
      typeof result === 'object' &&
      'webContentsId' in result &&
      typeof result.webContentsId === 'number'
    ) {
      const generation =
        'targetGeneration' in result && typeof result.targetGeneration === 'number'
          ? result.targetGeneration
          : undefined;
      if (
        this.attachedWebContentsId !== undefined &&
        (this.attachedWebContentsId !== result.webContentsId || this.targetGeneration !== generation)
      ) {
        // A replacement webview needs fresh Puppeteer domains, contexts and handles.
        await this.close();
      }
      this.attachedWebContentsId = result.webContentsId;
      this.targetGeneration = generation;
    }
    return result;
  }

  async listTools(): Promise<Tool[]> {
    try {
      const connection = await this.getConnection();
      this.upstreamTools = (await connection.listTools()).filter((tool) => !UNSUPPORTED_TOOLS.has(tool.name));
    } catch {
      // Opening a URL and importing state do not depend on downloading DevTools MCP.
      this.diagnostic(
        'Chrome DevTools tools could not be loaded; browser_open and browser_import_storage_state remain available.'
      );
    }
    return [...BROWSER_TOOLS, ...(this.upstreamTools ?? [])];
  }

  callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const call = this.pendingCall.catch(() => {}).then(() => this.execute(name, args));
    this.pendingCall = call;
    return call;
  }

  private async execute(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      if (name === 'browser_open') {
        const { url } = openArguments.parse(args);
        return toolResult(await this.request({ method: 'open', url }));
      }
      if (name === 'browser_import_storage_state') {
        const { file_path, origin } = importArguments.parse(args);
        return toolResult(
          await this.request({ method: 'importState', filePath: path.resolve(this.cwd, file_path), origin })
        );
      }
      if (!this.upstreamTools) await this.listTools();
      if (!this.upstreamTools?.some((tool) => tool.name === name)) {
        return { isError: true, content: [{ type: 'text', text: 'Unknown or unsupported in-app browser tool.' }] };
      }
      await this.request({ method: 'ensure' });
      return await (await this.getConnection()).callTool(name, args);
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? 'Invalid browser tool arguments.'
          : error instanceof Error
            ? error.message
            : 'The in-app browser operation failed.';
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (connection) await connection.then((value) => value.close()).catch(() => {});
  }
}

/** Build the standard MCP server consumed by existing AionCore agent adapters. */
export function createBrowserMcpServer(proxy: BrowserMcpProxy): Server {
  const server = new Server(
    { name: BUILTIN_BROWSER_MCP_NAME, version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Use these tools for the AionUi in-app browser. Start with browser_open when asked to open a website. browser_import_storage_state imports local Cookie and Local Storage files. Ordinary page tools operate on the same visible browser view.',
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await proxy.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    proxy.callTool(request.params.name, request.params.arguments ?? {})
  );
  return server;
}
