import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  BrowserMcpProxy,
  BrowserToolTransport,
  connectBrowserDevtools,
  createBrowserMcpServer,
  type BrowserDevtoolsConnection,
} from '@/process/resources/builtinMcp/browser/mcpProxy';

const result: CallToolResult = { content: [{ type: 'text', text: 'page content' }] };
const tool = (name: string): Tool => ({ name, inputSchema: { type: 'object' } });

const setup = (names = ['navigate_page', 'take_snapshot', 'click']) => {
  const control = vi.fn().mockResolvedValue({ webContentsId: 17 });
  const upstream: BrowserDevtoolsConnection = {
    listTools: vi.fn().mockResolvedValue(names.map(tool)),
    callTool: vi.fn().mockResolvedValue(result),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const connect = vi.fn().mockResolvedValue(upstream);
  const proxy = new BrowserMcpProxy({
    env: { AIONUI_CONVERSATION_ID: 'conversation-1' },
    cwd: process.cwd(),
    control,
    connectDevtools: connect,
    diagnostic: vi.fn(),
  });
  return { proxy, control, upstream, connect };
};

describe('in-app browser MCP tools', () => {
  it('discovers tools without opening a page and excludes unsupported tab operations', async () => {
    const { proxy, control } = setup(['new_page', 'close_page', 'select_page', 'navigate_page']);
    const tools = await proxy.listTools();
    expect(tools.map((entry) => entry.name)).toEqual(['browser_open', 'browser_import_storage_state', 'navigate_page']);
    expect(control).not.toHaveBeenCalled();
  });

  it('keeps opening and import discoverable if the downstream package cannot start', async () => {
    const proxy = new BrowserMcpProxy({
      connectDevtools: () => Promise.reject(new Error('offline')),
      diagnostic: vi.fn(),
    });
    expect((await proxy.listTools()).map((entry) => entry.name)).toEqual([
      'browser_open',
      'browser_import_storage_state',
    ]);
  });

  it('opens the requested website directly without depending on the downstream package', async () => {
    const { proxy, control, connect } = setup();
    await proxy.callTool('browser_open', { url: 'https://www.baidu.com' });
    expect(control).toHaveBeenCalledWith({
      method: 'open',
      url: 'https://www.baidu.com',
      conversationId: 'conversation-1',
      workspace: process.cwd(),
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('resolves a state file against the conversation workspace and preserves its origin', async () => {
    const { proxy, control } = setup();
    await proxy.callTool('browser_import_storage_state', {
      file_path: 'login/state.json',
      origin: 'https://example.com',
    });
    expect(control).toHaveBeenCalledWith({
      method: 'importState',
      filePath: path.resolve(process.cwd(), 'login/state.json'),
      origin: 'https://example.com',
      conversationId: 'conversation-1',
      workspace: process.cwd(),
    });
  });

  it('waits for a visible attached page before forwarding a real browser action', async () => {
    const { proxy, control, upstream } = setup();
    let attach: (() => void) | undefined;
    control.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          attach = resolve;
        })
    );
    const action = proxy.callTool('click', { uid: 'button-1' });
    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(expect.objectContaining({ method: 'ensure' })));
    expect(upstream.callTool).not.toHaveBeenCalled();
    attach?.();
    expect(await action).toEqual(result);
  });

  it('returns attachment errors without executing the action against a different page', async () => {
    const { proxy, control, upstream } = setup();
    control.mockRejectedValue(new Error('The requested conversation is unavailable.'));
    const response = await proxy.callTool('take_snapshot');
    expect(response.isError).toBe(true);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('reconnects page automation when the visible webview is replaced', async () => {
    const { proxy, control, upstream, connect } = setup();
    await proxy.callTool('take_snapshot');
    await proxy.callTool('take_snapshot');
    expect(connect).toHaveBeenCalledTimes(1);
    control.mockResolvedValue({ webContentsId: 42 });
    await proxy.callTool('browser_open', { url: 'https://example.com' });
    await proxy.callTool('take_snapshot');
    expect(upstream.close).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('reconnects after manual tab switching detaches and reattaches the same webview', async () => {
    const { proxy, control, upstream, connect } = setup();
    control.mockResolvedValue({ webContentsId: 17, targetGeneration: 1 });
    await proxy.callTool('take_snapshot');
    control.mockResolvedValue({ webContentsId: 17, targetGeneration: 3 });
    await proxy.callTool('take_snapshot');
    expect(upstream.close).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid import arguments before accessing any file', async () => {
    const { proxy, control } = setup();
    expect((await proxy.callTool('browser_import_storage_state', { file_path: '' })).isError).toBe(true);
    expect(control).not.toHaveBeenCalled();
  });

  it('rejects unsupported tools even if a client calls them directly', async () => {
    const { proxy, control, upstream } = setup(['new_page', 'click']);
    expect((await proxy.callTool('new_page', { url: 'https://example.com' })).isError).toBe(true);
    expect(control).not.toHaveBeenCalled();
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('serializes state import and later browsing actions', async () => {
    const { proxy, control } = setup();
    let imported: (() => void) | undefined;
    control.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          imported = resolve;
        })
    );
    const first = proxy.callTool('browser_import_storage_state', { file_path: 'state.json' });
    const second = proxy.callTool('browser_open', { url: 'https://example.com' });
    await vi.waitFor(() => expect(control).toHaveBeenCalledTimes(1));
    imported?.();
    await Promise.all([first, second]);
    expect(control.mock.calls.map(([command]) => command.method)).toEqual(['importState', 'open']);
  });

  it('forwards tool results over the standard MCP protocol used by the backend', async () => {
    const { proxy } = setup();
    const server = createBrowserMcpServer(proxy);
    const client = new Client({ name: 'browser-proxy-test', version: '1.0.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.map((entry) => entry.name)).toContain('browser_import_storage_state');
      expect(await client.callTool({ name: 'take_snapshot', arguments: {} })).toMatchObject(result);
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
    }
  });

  it('refuses to spawn a browser when bridge credentials are missing', async () => {
    await expect(connectBrowserDevtools({}, process.cwd())).rejects.toThrow('control bridge is unavailable');
  });
});

describe('browser MCP subprocess transport', () => {
  it('passes inherited runtime environment through real stdio without protocol noise', async () => {
    const script = `
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        let result = {};
        if (request.method === 'initialize') result = {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'transport-probe',version:'1.0.0'}};
        if (request.method === 'tools/list') result = {tools:[]};
        if (request.method === 'tools/call') result = {content:[{type:'text',text:process.env.AIONUI_BROWSER_TRANSPORT_TEST}]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
      });
    `;
    const transport = new BrowserToolTransport(
      process.execPath,
      ['-e', script],
      {
        ...process.env,
        AIONUI_BROWSER_TRANSPORT_TEST: 'inherited',
      },
      process.cwd()
    );
    const client = new Client({ name: 'browser-transport-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect(await client.callTool({ name: 'probe', arguments: {} })).toMatchObject({
        content: [{ type: 'text', text: 'inherited' }],
      });
    } finally {
      await client.close();
    }
  });

  it('rejects a failed subprocess start cleanly', async () => {
    const transport = new BrowserToolTransport(
      'aionui-nonexistent-browser-test-executable',
      [],
      process.env,
      process.cwd()
    );
    await expect(transport.start()).rejects.toThrow();
    await transport.close();
  });
});
