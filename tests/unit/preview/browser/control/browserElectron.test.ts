import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { BrowserToolTransport } from '@/process/resources/builtinMcp/browser/mcpProxy';

const enabled = process.env.AIONUI_BROWSER_ELECTRON_SMOKE === '1';
const root = process.cwd();
const marker = 'AIONUI_BROWSER_SMOKE:';
const require = createRequire(import.meta.url);

// The renderer is deliberately minimal; all production control, import and CDP code is real.
const electronMain = `
import { app, BrowserWindow } from 'electron';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { BrowserControlService } from '@/process/resources/builtinMcp/browser/BrowserControlService';
import { startCdpBridge } from '@/process/resources/builtinMcp/cdpBridge';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';

let host;
let guest;
let pendingView;
let commands;
const emit = (value) => process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(value) + '\\n');
const controller = new BrowserControlService({
  startBridge: startCdpBridge,
  getScriptPath: () => process.env.AIONUI_SMOKE_MCP_SCRIPT,
  requestView(request) {
    void (async () => {
      if (!guest || guest.isDestroyed()) {
        const ready = new Promise((resolve) => { pendingView = resolve; });
        await host.webContents.executeJavaScript('(() => { const view = document.createElement("webview"); view.setAttribute("partition", ' + JSON.stringify(BROWSER_SESSION_PARTITION) + '); view.src = ' + JSON.stringify(request.url || 'about:blank') + '; view.style.cssText = "width:100%;height:100%"; document.body.append(view); })()');
        await ready;
      } else if (request.url && guest.getURL() !== request.url) {
        await guest.loadURL(request.url);
      }
      await host.webContents.executeJavaScript('document.querySelector("webview").focus()');
      const result = controller.reportView(guest.id, request.requestId);
      if (!result.success) controller.failView(request.requestId);
    })().catch(() => controller.failView(request.requestId));
  },
});

async function stop() {
  commands?.close();
  await controller.close();
  if (host && !host.isDestroyed()) host.destroy();
}

async function main() {
  await app.whenReady();
  host = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  host.webContents.on('did-attach-webview', (_event, contents) => {
    guest = contents;
    contents.once('dom-ready', () => { pendingView?.(); pendingView = undefined; });
  });
  await host.loadURL('data:text/html,<html><body></body></html>');
  await controller.start();
  commands = createServer((socket) => createInterface({ input: socket }).on('line', (line) => {
    const respond = (value) => socket.end(JSON.stringify(value) + '\\n');
    void (async () => {
      const request = JSON.parse(line);
      if (request.method === 'views') return respond({ result: guest && !guest.isDestroyed() ? 1 : 0 });
      if (request.method === 'replace') {
        const old = guest;
        const destroyed = new Promise((resolve) => old.once('destroyed', resolve));
        await host.webContents.executeJavaScript('document.querySelector("webview").remove()');
        await destroyed;
        guest = undefined;
        return respond({ result: true });
      }
      if (request.method === 'shutdown') {
        await stop();
        respond({ result: true });
        app.quit();
      }
    })().catch((error) => respond({ error: String(error) }));
  }));
  await new Promise((resolve) => commands.listen(process.env.AIONUI_SMOKE_COMMAND_PIPE, resolve));
  emit({ ready: true, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AIONUI_CDP_') || key.startsWith('AIONUI_BROWSER_CONTROL_'))), initialViews: guest ? 1 : 0 });
}
main().catch(async (error) => { emit({ error: error.stack || String(error) }); await stop(); app.exit(1); });
`;

type Harness = {
  env: NodeJS.ProcessEnv;
  initialViews: number;
  request: (method: string) => Promise<unknown>;
  close: () => Promise<void>;
};

async function startElectron(main: string, directory: string, mcpScript: string): Promise<Harness> {
  const executable = require('electron') as string;
  const commandPipe =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\aionui-smoke-' + path.basename(directory)
      : path.join(directory, 'commands.sock');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIONUI_CDP_PORT: '1',
    AIONUI_E2E_TEST: '1',
    AIONUI_E2E_USER_DATA_DIR: path.join(directory, 'user-data'),
    AIONUI_SMOKE_MCP_SCRIPT: mcpScript,
    AIONUI_SMOKE_COMMAND_PIPE: commandPipe,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child: ChildProcessWithoutNullStreams = spawn(executable, [main], {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffer = '';
  let diagnostics = '';
  let readyResolve: (value: { env: NodeJS.ProcessEnv; initialViews: number }) => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<{ env: NodeJS.ProcessEnv; initialViews: number }>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const rejectAll = (error: Error): void => {
    readyReject(error);
  };
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-8_000);
  });
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.startsWith(marker)) continue;
      const message = JSON.parse(line.slice(marker.length));
      if (message.error) rejectAll(new Error(message.error));
      else if (message.ready) readyResolve(message);
    }
  });
  const exited = new Promise<void>((resolve) =>
    child.once('exit', (code) => {
      rejectAll(new Error('Electron exited with code ' + code + ': ' + diagnostics));
      resolve();
    })
  );
  child.once('error', rejectAll);
  const request = (method: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(commandPipe);
      let response = '';
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Electron smoke request timed out: ' + method + ': ' + diagnostics));
      }, 10_000);
      socket.once('connect', () => socket.write(JSON.stringify({ method }) + '\n'));
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString();
      });
      socket.once('end', () => {
        clearTimeout(timeout);
        try {
          const result = JSON.parse(response);
          if (result.error) reject(new Error(result.error));
          else resolve(result.result);
        } catch (error) {
          reject(error);
        }
      });
      socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  const close = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    await Promise.race([
      request('shutdown').catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (child.exitCode === null) {
      if (process.platform === 'win32' && child.pid) {
        await new Promise<void>((resolve) => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.once('exit', () => resolve());
          killer.once('error', () => resolve());
        });
      } else child.kill('SIGKILL');
    }
  };
  try {
    let timeout: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Electron did not become ready: ' + diagnostics)), 30_000);
      }),
    ]).finally(() => clearTimeout(timeout));
    return { ...result, request, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function startSite(): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(
      '<!doctype html><head><script>window.stateAtHead = { auth: localStorage.getItem("auth"), serverCookie: ' +
        JSON.stringify(request.headers.cookie || '') +
        ' };</script><title>Browser smoke</title></head><body><label>Name<input aria-label="Name" id="name"></label><button onclick="document.querySelector(\'#result\').textContent = document.querySelector(\'#name\').value">Submit</button><output id="result"></output></body>'
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Smoke server did not bind.');
  return { origin: 'http://127.0.0.1:' + address.port, server };
}

describe.skipIf(!enabled)('real Electron in-app browser', () => {
  it('opens and operates the actual webview, imports Playwright state before site scripts, and persists it across restart', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aionui-browser-electron-'));
    const mcpScript = path.join(directory, 'builtin-mcp-browser.cjs');
    const main = path.join(directory, 'main.cjs');
    const sites = await Promise.all([startSite(), startSite()]);
    let harness: Harness | undefined;
    let client: Client | undefined;
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const result = CallToolResultSchema.parse(
        await client!.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 120_000 })
      );
      if (result.isError) throw new Error('Tool ' + name + ' failed: ' + JSON.stringify(result));
      return result;
    };
    const connect = async (): Promise<void> => {
      harness = await startElectron(main, directory, mcpScript);
      client = new Client({ name: 'electron-browser-smoke', version: '1.0.0' });
      await client.connect(
        new BrowserToolTransport(
          process.execPath,
          [mcpScript],
          { ...process.env, ...harness.env, AIONUI_CONVERSATION_ID: 'smoke-conversation' },
          root
        )
      );
    };
    try {
      await build({
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        tsconfig: path.join(root, 'tsconfig.json'),
        entryPoints: [path.join(root, 'packages/desktop/src/process/resources/builtinMcp/browserServer.ts')],
        outfile: mcpScript,
      });
      await build({
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        tsconfig: path.join(root, 'tsconfig.json'),
        stdin: { contents: electronMain, resolveDir: root, loader: 'ts' },
        outfile: main,
        plugins: [
          {
            name: 'isolate-browser-smoke',
            setup(builder) {
              builder.onResolve({ filter: /^@\/common$|^@process\/utils\/initStorage$/ }, (args) => ({
                path: args.path,
                namespace: 'smoke-stub',
              }));
              builder.onLoad({ filter: /.*/, namespace: 'smoke-stub' }, (args) => ({
                contents:
                  args.path === '@/common'
                    ? 'export const ipcBridge = {};'
                    : 'export const getBuiltinMcpScriptPath = () => process.env.AIONUI_SMOKE_MCP_SCRIPT;',
                loader: 'js',
              }));
            },
          },
        ],
      });
      await connect();
      const tools = (await client!.listTools()).tools.map((entry) => entry.name);
      expect({ initialViews: await harness!.request('views'), tools }).toMatchObject({
        initialViews: 0,
        tools: expect.arrayContaining([
          'browser_open',
          'browser_import_storage_state',
          'evaluate_script',
          'take_snapshot',
          'click',
          'fill_form',
        ]),
      });
      await tool('browser_open', { url: sites[0].origin });
      const snapshot = await tool('take_snapshot');
      const snapshotText = snapshot.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
      const input = snapshotText.match(/uid=([^\s]+) textbox "Name"/);
      const button = snapshotText.match(/uid=([^\s]+) button "Submit"/);
      if (!input || !button)
        throw new Error('The real accessibility snapshot did not expose the form: ' + snapshotText);
      await tool('fill_form', { elements: [{ uid: input[1], value: 'agent filled' }] });
      await tool('click', { uid: button[1] });
      await tool('evaluate_script', {
        function:
          '() => { if (document.querySelector("#result").textContent !== "agent filled") throw new Error("form was not submitted"); return true; }',
      });
      const cookieSecret = 'http-only-smoke-secret';
      const values = ['origin-one-smoke-secret', 'origin-two-smoke-secret'];
      const statePath = path.join(directory, 'storage_state.json');
      await fs.writeFile(
        statePath,
        JSON.stringify({
          cookies: [
            {
              name: 'session',
              value: cookieSecret,
              domain: '127.0.0.1',
              path: '/',
              expires: Math.floor(Date.now() / 1000) + 3600,
              httpOnly: true,
              secure: false,
              sameSite: 'Lax',
            },
          ],
          origins: sites.map((site, index) => ({
            origin: site.origin,
            localStorage: [{ name: 'auth', value: values[index] }],
          })),
        })
      );
      const imported = JSON.stringify(await tool('browser_import_storage_state', { file_path: statePath }));
      expect({
        counts: JSON.parse(JSON.parse(imported).content[0].text),
        redacted: ![cookieSecret, ...values].some((value) => imported.includes(value)),
      }).toEqual({
        counts: {
          cookiesImported: 1,
          localStorageImported: 2,
          originsImported: 2,
          skippedExpiredCookies: 0,
          failures: [],
        },
        redacted: true,
      });
      const verifyState = async (index: number): Promise<unknown> => {
        const result = await tool('evaluate_script', {
          function:
            '() => ({ auth: window.stateAtHead.auth === ' +
            JSON.stringify(values[index]) +
            ', sentHttpOnlyCookie: window.stateAtHead.serverCookie.includes(' +
            JSON.stringify('session=' + cookieSecret) +
            '), hiddenFromScript: !document.cookie.includes("session="), localStorage: localStorage.getItem("auth") === ' +
            JSON.stringify(values[index]) +
            ' })',
        });
        const text = result.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n');
        const json = text.match(/```json\s*([\s\S]*?)```/);
        if (!json) throw new Error('Storage verification did not return JSON.');
        return JSON.parse(json[1]);
      };
      const restored = [await verifyState(0)];
      await tool('browser_open', { url: sites[1].origin });
      restored.push(await verifyState(1));
      await client!.close();
      client = undefined;
      await harness!.close();
      harness = undefined;
      await connect();
      await tool('browser_open', { url: sites[0].origin });
      restored.push(await verifyState(0));
      await tool('browser_open', { url: sites[1].origin });
      restored.push(await verifyState(1));
      expect(restored).toEqual(
        Array.from({ length: 4 }, () => ({
          auth: true,
          sentHttpOnlyCookie: true,
          hiddenFromScript: true,
          localStorage: true,
        }))
      );
      await harness!.request('replace');
      await tool('browser_open', { url: sites[0].origin });
      await tool('take_snapshot');
      await tool('evaluate_script', {
        function:
          '() => { if (!document.querySelector("#name")) throw new Error("replacement view was not attached"); return true; }',
      });
      const missing = await client!.callTool({
        name: 'browser_import_storage_state',
        arguments: { file_path: path.join(directory, 'missing.json') },
      });
      expect(missing).toMatchObject({ isError: true });
    } finally {
      await client?.close();
      await harness?.close();
      await Promise.all(sites.map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 180_000);
});
