import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CdpBridgeHandle } from '@/process/resources/builtinMcp/cdpBridge';
import { BrowserControlService } from '@/process/resources/builtinMcp/browser/BrowserControlService';
import type {
  BrowserControlResponse,
  BrowserOpenRequest,
} from '@/process/resources/builtinMcp/browser/controlProtocol';

const mocks = vi.hoisted(() => {
  const browserSession = {};
  const contents = new Map<
    number,
    {
      id: number;
      session: object;
      isDestroyed: () => boolean;
      getType: () => string;
      getURL: () => string;
      loadURL: (url: string) => Promise<void>;
    }
  >();
  return { browserSession, contents, setPort: vi.fn() };
});

vi.mock('electron', () => ({
  session: { fromPartition: () => mocks.browserSession },
  webContents: { fromId: (id: number) => mocks.contents.get(id) },
}));
vi.mock('@/common', () => ({ ipcBridge: { application: { browserOpenRequested: { emit: vi.fn() } } } }));
vi.mock('@/process/utils/initStorage', () => ({ getBuiltinMcpScriptPath: () => '/bundle/builtin-mcp-browser.js' }));
vi.mock('@/process/utils/configureChromium', () => ({ cdpStartupEnabled: true, setActiveCdpPort: mocks.setPort }));
vi.mock('@/process/resources/builtinMcp/cdpBridge', () => ({ startCdpBridge: vi.fn() }));

const services: BrowserControlService[] = [];
const runtimeEnvironment = [
  'AIONUI_CDP_ACTIVE_PORT',
  'AIONUI_CDP_BRIDGE_TOKEN',
  'AIONUI_BROWSER_CONTROL_PIPE',
  'AIONUI_BROWSER_CONTROL_TOKEN',
];
let savedEnvironment: Record<string, string | undefined>;

const request = (payload: unknown): Promise<BrowserControlResponse> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(process.env.AIONUI_BROWSER_CONTROL_PIPE!);
    let response = '';
    let received = false;
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk: string) => {
      response += chunk;
      const end = response.indexOf('\n');
      if (end < 0 || received) return;
      received = true;
      socket.destroy();
      resolve(JSON.parse(response.slice(0, end)) as BrowserControlResponse);
    });
    socket.once('error', reject);
    socket.once('close', () => {
      if (!received) reject(new Error('Browser control disconnected without a response.'));
    });
  });

const createService = (requestView: (request: BrowserOpenRequest) => void = () => undefined) => {
  let attachedId: number | null = null;
  const attach = vi.fn((id: number) => {
    attachedId = id;
    return { ok: true as const };
  });
  const close = vi.fn(async () => undefined);
  const bridge: CdpBridgeHandle = {
    port: 45678,
    token: 'bridge-token',
    attach,
    detach: vi.fn(() => {
      attachedId = null;
    }),
    close,
    attachedWebContentsId: () => attachedId,
  };
  const service = new BrowserControlService({
    startBridge: async () => bridge,
    requestView,
    getScriptPath: () => '/bundle/builtin-mcp-browser.js',
  });
  services.push(service);
  return { service, bridge, attach, close };
};

beforeEach(() => {
  savedEnvironment = Object.fromEntries(runtimeEnvironment.map((key) => [key, process.env[key]]));
  mocks.contents.clear();
  mocks.contents.set(7, {
    id: 7,
    session: mocks.browserSession,
    isDestroyed: () => false,
    getType: () => 'webview',
    getURL: () => 'https://example.com/',
    loadURL: async () => undefined,
  });
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('in-app browser control service', () => {
  it('publishes runtime credentials but excludes them from immutable conversation snapshots', async () => {
    const { service } = createService();
    await service.start();
    expect(process.env.AIONUI_CDP_ACTIVE_PORT).toBe('45678');
    expect(process.env.AIONUI_BROWSER_CONTROL_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(service.getSessionMcpServer()).toEqual({
      id: 'aionui-browser',
      name: 'aionui-browser',
      transport: { type: 'stdio', command: 'node', args: ['/bundle/builtin-mcp-browser.js'] },
    });
  });

  it('waits for the exact renderer request before acknowledging browser readiness', async () => {
    let requested: BrowserOpenRequest | undefined;
    const { service, attach } = createService((value) => {
      requested = value;
      queueMicrotask(() => service.reportView(7, value.requestId));
    });
    await service.start();
    const response = await request({
      token: process.env.AIONUI_BROWSER_CONTROL_TOKEN,
      method: 'ensure',
      conversationId: 'conversation-1',
    });
    expect(response).toEqual({
      ok: true,
      result: { url: 'https://example.com/', ready: true, webContentsId: 7, targetGeneration: 1 },
    });
    expect(requested?.conversationId).toBe('conversation-1');
    expect(attach).toHaveBeenCalledWith(7);
  });

  it('rejects an invalid token before requesting a browser view', async () => {
    const requestView = vi.fn();
    const { service } = createService(requestView);
    await service.start();
    expect(await request({ token: 'wrong', method: 'ensure' })).toEqual({
      ok: false,
      error: 'Browser control request was rejected.',
    });
    expect(requestView).not.toHaveBeenCalled();
  });

  it('awaits navigation after attaching the view before reporting the opened URL', async () => {
    const requested = vi.fn((value: BrowserOpenRequest) => {
      queueMicrotask(() => service.reportView(7, value.requestId));
    });
    const { service } = createService(requested);
    const contents = mocks.contents.get(7)!;
    contents.loadURL = vi.fn(async (url: string) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      contents.getURL = () => url;
    });
    await service.start();
    const response = await request({
      token: process.env.AIONUI_BROWSER_CONTROL_TOKEN,
      method: 'open',
      url: 'https://baidu.com/',
    });
    expect(response).toMatchObject({ ok: true, result: { url: 'https://baidu.com/', ready: true } });
    expect(requested.mock.calls[0][0]).not.toHaveProperty('url');
  });

  it('reports failed page navigation without exposing raw URL details', async () => {
    const { service } = createService((value) => {
      queueMicrotask(() => service.reportView(7, value.requestId));
    });
    mocks.contents.get(7)!.loadURL = async () => {
      throw new Error('private URL');
    };
    await service.start();
    const response = await request({
      token: process.env.AIONUI_BROWSER_CONTROL_TOKEN,
      method: 'open',
      url: 'https://example.com/',
    });
    expect(response).toEqual({ ok: false, error: 'The requested page could not be loaded in the in-app browser.' });
  });

  it('rejects a multibyte token without throwing from timing-safe comparison', async () => {
    const { service } = createService();
    await service.start();
    expect(await request({ token: 'é'.repeat(64), method: 'ensure' })).toMatchObject({ ok: false });
  });

  it('rejects script URLs before opening any view', async () => {
    const requestView = vi.fn();
    const { service } = createService(requestView);
    await service.start();
    const response = await request({
      token: process.env.AIONUI_BROWSER_CONTROL_TOKEN,
      method: 'open',
      url: 'javascript:alert(1)',
    });
    expect(response.ok).toBe(false);
    expect(requestView).not.toHaveBeenCalled();
  });

  it('refuses the application UI even when its session matches the browser partition', async () => {
    const { service, attach } = createService();
    await service.start();
    mocks.contents.set(8, { ...mocks.contents.get(7)!, id: 8, getType: () => 'window' });
    expect(service.reportView(8)).toMatchObject({ success: false });
    expect(attach).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -1, 0, 1.2])('rejects malformed webContents identifiers: %s', async (id) => {
    const { service, attach } = createService();
    await service.start();
    expect(service.reportView(id)).toMatchObject({ success: false });
    expect(attach).not.toHaveBeenCalled();
  });

  it('refuses unrelated office webviews and sessions', async () => {
    const { service, attach } = createService();
    await service.start();
    mocks.contents.set(8, { ...mocks.contents.get(7)!, id: 8, session: {} });
    expect(service.reportView(8)).toMatchObject({ success: false });
    expect(attach).not.toHaveBeenCalled();
  });

  it('ignores delayed readiness reports without replacing the active target', async () => {
    const { service, attach } = createService();
    await service.start();
    expect(service.reportView(7, 'expired-request')).toEqual({ success: true });
    expect(attach).not.toHaveBeenCalled();
  });

  it('changes target generation when manual selection moves away and back to the same view', async () => {
    const { service } = createService((value) => {
      queueMicrotask(() => service.reportView(7, value.requestId));
    });
    mocks.contents.set(8, { ...mocks.contents.get(7)!, id: 8 });
    await service.start();
    expect(service.reportView(7)).toEqual({ success: true });
    expect(service.reportView(8)).toEqual({ success: true });
    expect(service.reportView(7)).toEqual({ success: true });
    const response = await request({ token: process.env.AIONUI_BROWSER_CONTROL_TOKEN, method: 'ensure' });
    expect(response).toMatchObject({ ok: true, result: { webContentsId: 7, targetGeneration: 3 } });
  });

  it('turns renderer failures into bounded operation errors', async () => {
    const { service } = createService((value) => {
      queueMicrotask(() => service.failView(value.requestId, 'untrusted renderer detail'));
    });
    await service.start();
    const response = await request({ token: process.env.AIONUI_BROWSER_CONTROL_TOKEN, method: 'ensure' });
    expect(response).toEqual({ ok: false, error: 'The in-app browser view could not be opened.' });
  });

  it('clears credentials and closes both channels on shutdown', async () => {
    const { service, close } = createService();
    await service.start();
    await service.close();
    expect(process.env.AIONUI_BROWSER_CONTROL_TOKEN).toBeUndefined();
    expect(service.getSessionMcpServer()).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });
});
