/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IRuntimeStatusEvent, IRuntimeStatusScope } from '@/common/adapter/ipcBridge';
import { execFile } from 'child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import fs from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import yauzl from 'yauzl';
import { getSystemDir } from '../utils/initStorage';
import { getDataPath } from '../utils/utils';

export type OpenCodeBootstrapStatus = 'ready' | 'skipped' | 'failed';

export type OpenCodeBootstrapResult = {
  status: OpenCodeBootstrapStatus;
  error?: string;
};

export type OpenCodeManagedAgentHealthResult = {
  checked: boolean;
  agentId?: string;
  status?: string;
  error?: string;
};

type ManagedAcpTool = {
  commandName: string;
  displayName: string;
  envDisabledKey:
    | 'AIONUI_BEISEN_CLI_BOOTSTRAP'
    | 'AIONUI_CODEX_BOOTSTRAP'
    | 'AIONUI_DWS_BOOTSTRAP'
    | 'AIONUI_GOOGLEWORKSPACE_CLI_BOOTSTRAP'
    | 'AIONUI_NOXINFLUENCER_CLI_BOOTSTRAP'
    | 'AIONUI_OFFICECLI_BOOTSTRAP'
    | 'AIONUI_OPENCODE_BOOTSTRAP'
    | 'AIONUI_SHOPIFY_CLI_BOOTSTRAP'
    | 'AIONUI_ZINIAO_OPEN_BOOTSTRAP';
  match: string | readonly string[];
  packageName: string;
  packageSpec?: string;
  scope: IRuntimeStatusScope;
  toolId:
    | 'beisen-cli'
    | 'codex'
    | 'dws'
    | 'googleworkspace-cli'
    | 'noxinfluencer-cli'
    | 'officecli'
    | 'opencode'
    | 'shopify-cli'
    | 'ziniao-open';
};

type EnsureNodeRuntime = (params: { scope: IRuntimeStatusScope }) => Promise<{ ready: boolean }>;
type CommandRunner = (
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  }
) => Promise<{ stderr?: string; stdout?: string }>;
type RuntimeStatusEmitter = (event: IRuntimeStatusEvent) => void;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type OpenCodeStartupEnv = {
  AIONUI_BEISEN_CLI_BOOTSTRAP?: string;
  AIONUI_CODEX_BOOTSTRAP?: string;
  AIONUI_DWS_BOOTSTRAP?: string;
  AIONUI_OFFICECLI_BOOTSTRAP?: string;
  AIONUI_E2E_TEST?: string;
  AIONUI_GOOGLEWORKSPACE_CLI_BOOTSTRAP?: string;
  AIONUI_NOXINFLUENCER_CLI_BOOTSTRAP?: string;
  AIONUI_OPENCODE_BOOTSTRAP?: string;
  AIONUI_SHOPIFY_CLI_BOOTSTRAP?: string;
  AIONUI_ZINIAO_OPEN_BOOTSTRAP?: string;
};

export type EnsureOpenCodeReadyOptions = {
  commandRunner?: CommandRunner;
  dataPath?: string;
  emitStatus?: RuntimeStatusEmitter;
  ensureNodeRuntime?: EnsureNodeRuntime;
  env?: OpenCodeStartupEnv;
  packageName?: string;
  scope?: IRuntimeStatusScope;
};

export type CheckOpenCodeManagedAgentHealthOptions = {
  backendPort: number;
  bootstrapResult: OpenCodeBootstrapResult | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

type ApiEnvelope<T> = {
  data?: T;
};

type ManagedAgentRow = {
  id?: string;
  name?: string;
  backend?: string;
  agent_type?: string;
  enabled?: boolean;
  status?: string;
};

const OPENCODE_TOOL_ID = 'opencode';
const OPENCODE_PACKAGE_NAME = 'opencode-ai';
const OPENCODE_AGENT_MATCH = 'opencode';
const OPENCODE_STARTUP_SCOPE: IRuntimeStatusScope = {
  kind: 'custom_agent',
  id: 'startup-opencode',
};
const BEISEN_CLI_TOOL_ID = 'beisen-cli';
const BEISEN_CLI_PACKAGE_NAME = 'beisen-cli';
const BEISEN_CLI_STARTUP_SCOPE: IRuntimeStatusScope = {
  kind: 'mcp',
  id: 'startup-beisen-cli',
};
const CODEX_TOOL_ID = 'codex';
const CODEX_PACKAGE_NAME = '@openai/codex';
const CODEX_AGENT_MATCH = 'codex';
const CODEX_STARTUP_SCOPE: IRuntimeStatusScope = {
  kind: 'custom_agent',
  id: 'startup-codex',
};
type CodexPluginSpec = {
  displayName: string;
  marketplaceName: string;
  marketplaceUrl?: string;
  pluginId: string;
};

const CHATCUT_PLUGIN_SPEC: CodexPluginSpec = {
  displayName: 'ChatCut',
  marketplaceName: 'chatcut-inc',
  marketplaceUrl: 'https://github.com/ChatCut-Inc/agent-plugin.git',
  pluginId: 'chatcut@chatcut-inc',
};
const ADSPIRER_PLUGIN_SPEC: CodexPluginSpec = {
  displayName: 'Adspirer',
  marketplaceName: 'adspirer-marketplace',
  marketplaceUrl: 'https://github.com/amekala/ads-mcp.git',
  pluginId: 'adspirer-ads-agent@adspirer-marketplace',
};
const SHOPIFY_PLUGIN_SPEC: CodexPluginSpec = {
  displayName: 'Shopify',
  marketplaceName: 'shopify-ai-toolkit',
  marketplaceUrl: 'https://github.com/Shopify/Shopify-AI-Toolkit.git',
  pluginId: 'shopify-plugin@shopify-ai-toolkit',
};
const DWS_TOOL_ID = 'dws';
const DWS_COMMAND_NAME = 'dws';
const DWS_PACKAGE_NAME = 'dingtalk-workspace-cli';
const DWS_AGENT_MATCH = ['monoskill', 'dws', 'dingtalk'] as const;
const DWS_STARTUP_SCOPE: IRuntimeStatusScope = {
  kind: 'custom_agent',
  id: 'startup-dws',
};
const GOOGLEWORKSPACE_CLI_TOOL_ID = 'googleworkspace-cli';
const GOOGLEWORKSPACE_CLI_COMMAND_NAME = 'gws';
const GOOGLEWORKSPACE_CLI_PACKAGE_NAME = '@googleworkspace/cli';
const GOOGLEWORKSPACE_CLI_STARTUP_SCOPE: IRuntimeStatusScope = {
  kind: 'mcp',
  id: 'startup-googleworkspace-cli',
};
const NOXINFLUENCER_CLI_TOOL_ID = 'noxinfluencer-cli';
const NOXINFLUENCER_CLI_COMMAND_NAME = 'noxinfluencer';
const NOXINFLUENCER_CLI_PACKAGE_NAME = '@noxinfluencer/cli';
const NOXINFLUENCER_CLI_STARTUP_SCOPE: IRuntimeStatusScope = {
  kind: 'mcp',
  id: 'startup-noxinfluencer-cli',
};
const OFFICECLI_TOOL_ID = 'officecli';
const OFFICECLI_PACKAGE_NAME = '@officecli/officecli';
const OFFICECLI_AGENT_MATCH = 'officecli';
const OFFICECLI_STARTUP_SCOPE: IRuntimeStatusScope = {
  kind: 'custom_agent',
  id: 'startup-officecli',
};
const SHOPIFY_CLI_TOOL_ID = 'shopify-cli';
const SHOPIFY_CLI_COMMAND_NAME = 'shopify';
const SHOPIFY_CLI_PACKAGE_NAME = '@shopify/cli';
const SHOPIFY_CLI_STARTUP_SCOPE: IRuntimeStatusScope = {
  kind: 'mcp',
  id: 'startup-shopify-cli',
};
const ZINIAO_OPEN_TOOL_ID = 'ziniao-open';
const ZINIAO_OPEN_COMMAND_NAME = 'ziniao-cli';
const ZINIAO_OPEN_PACKAGE_NAME = '@ziniao-open/cli';
const ZINIAO_OPEN_STARTUP_SCOPE: IRuntimeStatusScope = {
  kind: 'mcp',
  id: 'startup-ziniao-open',
};
const HEALTH_CHECK_TIMEOUT_MS = 30000;
const OPENCODE_INSTALL_TIMEOUT_MS = 180000;
const MANAGED_NPM_REGISTRY = 'https://registry.npmmirror.com';
const MANAGED_NODE_LAUNCHER_MARKER = 'AionUi managed Node launcher';
const MANAGED_DIRECT_LAUNCHER_MARKER = 'AionUi managed direct launcher';
const DWS_PLATFORM_ARCHIVES: Record<string, string> = {
  'darwin-arm64': 'dws-darwin-arm64.tar.gz',
  'darwin-x64': 'dws-darwin-amd64.tar.gz',
  'linux-arm64': 'dws-linux-arm64.tar.gz',
  'linux-x64': 'dws-linux-amd64.tar.gz',
  'win32-arm64': 'dws-windows-arm64.zip',
  'win32-x64': 'dws-windows-amd64.zip',
};

const OPENCODE_TOOL: ManagedAcpTool = {
  commandName: OPENCODE_TOOL_ID,
  displayName: 'OpenCode',
  envDisabledKey: 'AIONUI_OPENCODE_BOOTSTRAP',
  match: OPENCODE_AGENT_MATCH,
  packageName: OPENCODE_PACKAGE_NAME,
  scope: OPENCODE_STARTUP_SCOPE,
  toolId: OPENCODE_TOOL_ID,
};

const BEISEN_CLI_TOOL: ManagedAcpTool = {
  commandName: BEISEN_CLI_TOOL_ID,
  displayName: 'Beisen CLI',
  envDisabledKey: 'AIONUI_BEISEN_CLI_BOOTSTRAP',
  match: BEISEN_CLI_TOOL_ID,
  packageName: BEISEN_CLI_PACKAGE_NAME,
  scope: BEISEN_CLI_STARTUP_SCOPE,
  toolId: BEISEN_CLI_TOOL_ID,
};

const CODEX_TOOL: ManagedAcpTool = {
  commandName: CODEX_TOOL_ID,
  displayName: 'Codex',
  envDisabledKey: 'AIONUI_CODEX_BOOTSTRAP',
  match: CODEX_AGENT_MATCH,
  packageName: CODEX_PACKAGE_NAME,
  scope: CODEX_STARTUP_SCOPE,
  toolId: CODEX_TOOL_ID,
};

const DWS_TOOL: ManagedAcpTool = {
  commandName: DWS_COMMAND_NAME,
  displayName: 'DingTalk DWS',
  envDisabledKey: 'AIONUI_DWS_BOOTSTRAP',
  match: DWS_AGENT_MATCH,
  packageName: DWS_PACKAGE_NAME,
  scope: DWS_STARTUP_SCOPE,
  toolId: DWS_TOOL_ID,
};

const GOOGLEWORKSPACE_CLI_TOOL: ManagedAcpTool = {
  commandName: GOOGLEWORKSPACE_CLI_COMMAND_NAME,
  displayName: 'Google Workspace CLI',
  envDisabledKey: 'AIONUI_GOOGLEWORKSPACE_CLI_BOOTSTRAP',
  match: GOOGLEWORKSPACE_CLI_TOOL_ID,
  packageName: GOOGLEWORKSPACE_CLI_PACKAGE_NAME,
  scope: GOOGLEWORKSPACE_CLI_STARTUP_SCOPE,
  toolId: GOOGLEWORKSPACE_CLI_TOOL_ID,
};

const NOXINFLUENCER_CLI_TOOL: ManagedAcpTool = {
  commandName: NOXINFLUENCER_CLI_COMMAND_NAME,
  displayName: 'Noxinfluencer CLI',
  envDisabledKey: 'AIONUI_NOXINFLUENCER_CLI_BOOTSTRAP',
  match: NOXINFLUENCER_CLI_TOOL_ID,
  packageName: NOXINFLUENCER_CLI_PACKAGE_NAME,
  packageSpec: '@noxinfluencer/cli@latest',
  scope: NOXINFLUENCER_CLI_STARTUP_SCOPE,
  toolId: NOXINFLUENCER_CLI_TOOL_ID,
};

const OFFICECLI_TOOL: ManagedAcpTool = {
  commandName: OFFICECLI_TOOL_ID,
  displayName: 'OfficeCLI',
  envDisabledKey: 'AIONUI_OFFICECLI_BOOTSTRAP',
  match: OFFICECLI_AGENT_MATCH,
  packageName: OFFICECLI_PACKAGE_NAME,
  scope: OFFICECLI_STARTUP_SCOPE,
  toolId: OFFICECLI_TOOL_ID,
};

const SHOPIFY_CLI_TOOL: ManagedAcpTool = {
  commandName: SHOPIFY_CLI_COMMAND_NAME,
  displayName: 'Shopify CLI',
  envDisabledKey: 'AIONUI_SHOPIFY_CLI_BOOTSTRAP',
  match: SHOPIFY_CLI_TOOL_ID,
  packageName: SHOPIFY_CLI_PACKAGE_NAME,
  scope: SHOPIFY_CLI_STARTUP_SCOPE,
  toolId: SHOPIFY_CLI_TOOL_ID,
};

const ZINIAO_OPEN_TOOL: ManagedAcpTool = {
  commandName: ZINIAO_OPEN_COMMAND_NAME,
  displayName: 'Ziniao Open',
  envDisabledKey: 'AIONUI_ZINIAO_OPEN_BOOTSTRAP',
  match: ZINIAO_OPEN_TOOL_ID,
  packageName: ZINIAO_OPEN_PACKAGE_NAME,
  scope: ZINIAO_OPEN_STARTUP_SCOPE,
  toolId: ZINIAO_OPEN_TOOL_ID,
};

const STARTUP_TOOLS = [
  OPENCODE_TOOL,
  BEISEN_CLI_TOOL,
  CODEX_TOOL,
  DWS_TOOL,
  GOOGLEWORKSPACE_CLI_TOOL,
  NOXINFLUENCER_CLI_TOOL,
  OFFICECLI_TOOL,
  SHOPIFY_CLI_TOOL,
  ZINIAO_OPEN_TOOL,
] as const;

const execFileAsync = promisify(execFile);

let startupPromise: Promise<OpenCodeBootstrapResult> | null = null;

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isReadyForManagedAgentHealthCheck(result: OpenCodeBootstrapResult | null): boolean {
  return result?.status === 'ready';
}

function unwrapApiData<T>(value: T | ApiEnvelope<T>): T {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'data' in value) {
    return (value as ApiEnvelope<T>).data as T;
  }
  return value as T;
}

async function fetchJsonWithTimeout<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const parsed = (await response.json()) as T | ApiEnvelope<T>;
    return unwrapApiData(parsed);
  } finally {
    clearTimeout(timeout);
  }
}

function findManagedAgent(rows: ManagedAgentRow[], match: string | readonly string[]): ManagedAgentRow | undefined {
  const matches = Array.isArray(match) ? match : [match];
  return rows.find((agent) => {
    const fields = [agent.id, agent.name, agent.backend, agent.agent_type].filter(Boolean).join(' ').toLowerCase();
    return matches.some((item) => fields.includes(item)) && agent.enabled !== false;
  });
}

function getCodexHomeDir(dataPath = getSystemDir().workDir): string {
  return path.join(dataPath, 'runtime', 'codex-home');
}

function getOpenCodeConfigDir(dataPath = getSystemDir().workDir): string {
  return path.join(dataPath, 'runtime', 'opencode-home');
}

async function ensureManagedAgentEnvOverride(agentId: string, name: string, value: string): Promise<void> {
  try {
    const current = await ipcBridge.acpConversation.getAgentOverrides.invoke({ id: agentId });
    const envOverride = (current.env_override ?? []).filter((item) => item.name !== name);
    envOverride.push({ name, value });
    await ipcBridge.acpConversation.setAgentOverrides.invoke({
      id: agentId,
      command_override: current.command_override ?? null,
      env_override: envOverride,
    });
  } catch (error) {
    console.warn(`[ACP Tool] failed to set ${name} env override:`, normalizeError(error));
  }
}

function emitToolRuntimeStatus(
  emitStatus: RuntimeStatusEmitter,
  tool: ManagedAcpTool,
  phase: IRuntimeStatusEvent['phase'],
  message?: string
): void {
  emitStatus({
    resource: 'acp_tool',
    resource_id: tool.toolId,
    scope: tool.scope,
    phase,
    message,
  });
}

function getManagedToolNpmPrefix(tool: ManagedAcpTool, dataPath = getDataPath()): string {
  return path.join(dataPath, 'runtime', 'npm-global', tool.toolId);
}

function getManagedToolGlobalBinDir(tool: ManagedAcpTool, dataPath = getDataPath()): string {
  const prefix = getManagedToolNpmPrefix(tool, dataPath);
  return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

function prependPathEntry(binDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const currentPath = env.PATH ?? env.Path ?? '';
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  const hasBinDir = entries.some((entry) => path.resolve(entry).toLowerCase() === path.resolve(binDir).toLowerCase());
  if (!hasBinDir) {
    const updatedPath = [binDir, ...entries].join(path.delimiter);
    env.PATH = updatedPath;
    if (process.platform === 'win32') {
      env.Path = updatedPath;
    }
  }
}

function findManagedNodeExecutableSync(dataPath = getDataPath()): string | null {
  const nodeRuntimeDir = path.join(dataPath, 'runtime', 'node');
  let entries: string[];
  try {
    entries = readdirSync(nodeRuntimeDir);
  } catch {
    return null;
  }

  const candidates = entries
    .filter((entry) => entry.startsWith('node-v'))
    .toSorted()
    .toReversed()
    .map((entry) => {
      const runtimeRoot = path.join(nodeRuntimeDir, entry);
      return process.platform === 'win32' ? path.join(runtimeRoot, 'node.exe') : path.join(runtimeRoot, 'bin', 'node');
    });

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function addManagedNodeBinToPath(dataPath = getDataPath(), env: NodeJS.ProcessEnv = process.env): string | null {
  const nodeExecutable = findManagedNodeExecutableSync(dataPath);
  if (!nodeExecutable) {
    return null;
  }

  const binDir = path.dirname(nodeExecutable);
  prependPathEntry(binDir, env);
  return binDir;
}

function addManagedToolGlobalBinToPath(
  tool: ManagedAcpTool,
  dataPath = getDataPath(),
  env: NodeJS.ProcessEnv = process.env
): string {
  const binDir = getManagedToolGlobalBinDir(tool, dataPath);
  prependPathEntry(binDir, env);
  return binDir;
}

export function addOpenCodeGlobalBinToPath(dataPath = getDataPath(), env: NodeJS.ProcessEnv = process.env): string {
  return addManagedToolGlobalBinToPath(OPENCODE_TOOL, dataPath, env);
}

export function addBeisenCliGlobalBinToPath(dataPath = getDataPath(), env: NodeJS.ProcessEnv = process.env): string {
  return addManagedToolGlobalBinToPath(BEISEN_CLI_TOOL, dataPath, env);
}

export function addCodexGlobalBinToPath(dataPath = getDataPath(), env: NodeJS.ProcessEnv = process.env): string {
  return addManagedToolGlobalBinToPath(CODEX_TOOL, dataPath, env);
}

export function addDwsGlobalBinToPath(dataPath = getDataPath(), env: NodeJS.ProcessEnv = process.env): string {
  return addManagedToolGlobalBinToPath(DWS_TOOL, dataPath, env);
}

export function addGoogleWorkspaceCliGlobalBinToPath(
  dataPath = getDataPath(),
  env: NodeJS.ProcessEnv = process.env
): string {
  return addManagedToolGlobalBinToPath(GOOGLEWORKSPACE_CLI_TOOL, dataPath, env);
}

export function addNoxinfluencerCliGlobalBinToPath(
  dataPath = getDataPath(),
  env: NodeJS.ProcessEnv = process.env
): string {
  return addManagedToolGlobalBinToPath(NOXINFLUENCER_CLI_TOOL, dataPath, env);
}

export function addOfficeCliGlobalBinToPath(dataPath = getDataPath(), env: NodeJS.ProcessEnv = process.env): string {
  return addManagedToolGlobalBinToPath(OFFICECLI_TOOL, dataPath, env);
}

export function addShopifyCliGlobalBinToPath(dataPath = getDataPath(), env: NodeJS.ProcessEnv = process.env): string {
  return addManagedToolGlobalBinToPath(SHOPIFY_CLI_TOOL, dataPath, env);
}

export function addZiniaoOpenGlobalBinToPath(dataPath = getDataPath(), env: NodeJS.ProcessEnv = process.env): string {
  return addManagedToolGlobalBinToPath(ZINIAO_OPEN_TOOL, dataPath, env);
}

export function addStartupManagedAcpToolBinsToPath(
  dataPath = getDataPath(),
  env: NodeJS.ProcessEnv = process.env
): void {
  const nodeExecutable = findManagedNodeExecutableSync(dataPath);
  if (nodeExecutable) {
    prependPathEntry(path.dirname(nodeExecutable), env);
  }
  for (const tool of STARTUP_TOOLS) {
    addManagedToolGlobalBinToPath(tool, dataPath, env);
    if (nodeExecutable) {
      ensureManagedToolLauncherUsesManagedNodeSync(tool, dataPath, nodeExecutable);
    }
  }
}

function getManagedToolCommandPath(tool: ManagedAcpTool, dataPath = getDataPath()): string {
  const binDir = getManagedToolGlobalBinDir(tool, dataPath);
  return path.join(binDir, process.platform === 'win32' ? `${tool.commandName}.cmd` : tool.commandName);
}

function getManagedToolPackageRoot(tool: ManagedAcpTool, dataPath = getDataPath()): string {
  const prefix = getManagedToolNpmPrefix(tool, dataPath);
  return process.platform === 'win32'
    ? path.join(prefix, 'node_modules', tool.packageName)
    : path.join(prefix, 'lib', 'node_modules', tool.packageName);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findManagedNodeExecutable(dataPath = getDataPath()): Promise<string | null> {
  const nodeRuntimeDir = path.join(dataPath, 'runtime', 'node');
  let entries: string[];
  try {
    entries = await fs.readdir(nodeRuntimeDir);
  } catch {
    return null;
  }

  const candidates = entries
    .filter((entry) => entry.startsWith('node-v'))
    .toSorted()
    .toReversed()
    .map((entry) => {
      const runtimeRoot = path.join(nodeRuntimeDir, entry);
      return process.platform === 'win32' ? path.join(runtimeRoot, 'node.exe') : path.join(runtimeRoot, 'bin', 'node');
    });

  const candidateChecks = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      exists: await pathExists(candidate),
    }))
  );
  return candidateChecks.find((check) => check.exists)?.candidate ?? null;
}

function getNpmCliPath(nodeExecutable: string): string {
  if (process.platform === 'win32') {
    return path.join(path.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  }

  const nodeRoot = path.dirname(path.dirname(nodeExecutable));
  return path.join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

async function findManagedToolPackageBinTarget(tool: ManagedAcpTool, dataPath = getDataPath()): Promise<string | null> {
  const packageRoot = getManagedToolPackageRoot(tool, dataPath);
  const packageJsonPath = path.join(packageRoot, 'package.json');
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  } catch {
    return null;
  }
  if (!packageJson || typeof packageJson !== 'object' || !('bin' in packageJson)) {
    return null;
  }

  const bin = (packageJson as { bin?: unknown }).bin;
  if (typeof bin === 'string') {
    return path.join(packageRoot, bin);
  }
  if (bin && typeof bin === 'object') {
    const commandTarget = (bin as Record<string, unknown>)[tool.commandName];
    if (typeof commandTarget === 'string') {
      return path.join(packageRoot, commandTarget);
    }
    const fallbackTarget = Object.values(bin).find((value): value is string => typeof value === 'string');
    if (fallbackTarget) {
      return path.join(packageRoot, fallbackTarget);
    }
  }
  return null;
}

function findManagedToolPackageBinTargetSync(tool: ManagedAcpTool, dataPath = getDataPath()): string | null {
  const packageRoot = getManagedToolPackageRoot(tool, dataPath);
  const packageJsonPath = path.join(packageRoot, 'package.json');
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return null;
  }
  if (!packageJson || typeof packageJson !== 'object' || !('bin' in packageJson)) {
    return null;
  }

  const bin = (packageJson as { bin?: unknown }).bin;
  if (typeof bin === 'string') {
    return path.join(packageRoot, bin);
  }
  if (bin && typeof bin === 'object') {
    const commandTarget = (bin as Record<string, unknown>)[tool.commandName];
    if (typeof commandTarget === 'string') {
      return path.join(packageRoot, commandTarget);
    }
    const fallbackTarget = Object.values(bin).find((value): value is string => typeof value === 'string');
    if (fallbackTarget) {
      return path.join(packageRoot, fallbackTarget);
    }
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildManagedNodeLauncher(nodeExecutable: string, targetPath: string): string {
  const encodedTarget = Buffer.from(targetPath, 'utf8').toString('base64');
  return [
    '#!/bin/sh',
    `# ${MANAGED_NODE_LAUNCHER_MARKER}`,
    `# target_b64=${encodedTarget}`,
    `exec ${shellQuote(nodeExecutable)} ${shellQuote(targetPath)} "$@"`,
    '',
  ].join('\n');
}

function buildManagedDirectLauncher(targetPath: string): string {
  const encodedTarget = Buffer.from(targetPath, 'utf8').toString('base64');
  return [
    '#!/bin/sh',
    `# ${MANAGED_DIRECT_LAUNCHER_MARKER}`,
    `# target_b64=${encodedTarget}`,
    `exec ${shellQuote(targetPath)} "$@"`,
    '',
  ].join('\n');
}

async function isManagedToolNodeScriptTarget(targetPath: string): Promise<boolean> {
  const extension = path.extname(targetPath).toLowerCase();
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return true;
  }
  try {
    const handle = await fs.open(targetPath, 'r');
    try {
      const buffer = Buffer.alloc(256);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const chunk = buffer.subarray(0, bytesRead);
      if (chunk.includes(0)) {
        return false;
      }
      const firstLine = chunk.toString('utf8').split(/\r?\n/, 1)[0] ?? '';
      return /^#!.*\bnode\b/i.test(firstLine);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

function isManagedToolNodeScriptTargetSync(targetPath: string): boolean {
  const extension = path.extname(targetPath).toLowerCase();
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return true;
  }
  try {
    const fd = openSync(targetPath, 'r');
    const buffer = Buffer.alloc(256);
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      closeSync(fd);
    }
    const chunk = buffer.subarray(0, bytesRead);
    if (chunk.includes(0)) {
      return false;
    }
    const firstLine = chunk.toString('utf8').split(/\r?\n/, 1)[0] ?? '';
    return /^#!.*\bnode\b/i.test(firstLine);
  } catch {
    return false;
  }
}

async function buildManagedToolLauncher(nodeExecutable: string, targetPath: string): Promise<string> {
  return (await isManagedToolNodeScriptTarget(targetPath))
    ? buildManagedNodeLauncher(nodeExecutable, targetPath)
    : buildManagedDirectLauncher(targetPath);
}

function buildManagedToolLauncherSync(nodeExecutable: string, targetPath: string): string {
  return isManagedToolNodeScriptTargetSync(targetPath)
    ? buildManagedNodeLauncher(nodeExecutable, targetPath)
    : buildManagedDirectLauncher(targetPath);
}

async function ensureManagedToolLauncherUsesManagedNode(
  tool: ManagedAcpTool,
  dataPath: string,
  nodeExecutable: string
): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }

  const commandPath = getManagedToolCommandPath(tool, dataPath);
  if (!(await pathExists(commandPath))) {
    return;
  }

  const targetPath = await findManagedToolPackageBinTarget(tool, dataPath);
  if (!targetPath || !(await pathExists(targetPath))) {
    return;
  }

  const launcher = await buildManagedToolLauncher(nodeExecutable, targetPath);
  try {
    const current = await fs.readFile(commandPath, 'utf8');
    if (current === launcher) {
      return;
    }
  } catch {
    // npm commonly creates a symlink here; reading can fail on broken or stale launchers.
  }

  await fs.rm(commandPath, { force: true });
  await fs.writeFile(commandPath, launcher, { mode: 0o755 });
  await fs.chmod(commandPath, 0o755);
}

function ensureManagedToolLauncherUsesManagedNodeSync(
  tool: ManagedAcpTool,
  dataPath: string,
  nodeExecutable: string
): void {
  if (process.platform === 'win32') {
    return;
  }

  const commandPath = getManagedToolCommandPath(tool, dataPath);
  if (!existsSync(commandPath)) {
    return;
  }

  const targetPath = findManagedToolPackageBinTargetSync(tool, dataPath);
  if (!targetPath || !existsSync(targetPath)) {
    return;
  }

  const launcher = buildManagedToolLauncherSync(nodeExecutable, targetPath);
  try {
    if (readFileSync(commandPath, 'utf8') === launcher) {
      return;
    }
  } catch {
    // npm commonly creates a symlink here; reading can fail on broken or stale launchers.
  }

  rmSync(commandPath, { force: true });
  writeFileSync(commandPath, launcher, { mode: 0o755 });
  chmodSync(commandPath, 0o755);
}

async function runCommand(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  }
): Promise<{ stderr?: string; stdout?: string }> {
  const { stderr, stdout } = await execFileAsync(file, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    windowsHide: true,
  });
  return {
    stderr: typeof stderr === 'string' ? stderr : undefined,
    stdout: typeof stdout === 'string' ? stdout : undefined,
  };
}

function getDwsPackageRoot(prefix: string): string {
  return process.platform === 'win32'
    ? path.join(prefix, 'node_modules', DWS_PACKAGE_NAME)
    : path.join(prefix, 'lib', 'node_modules', DWS_PACKAGE_NAME);
}

function getDwsBinaryPath(prefix: string): string {
  return path.join(getDwsPackageRoot(prefix), 'vendor', process.platform === 'win32' ? 'dws.exe' : 'dws');
}

function getDwsArchiveName(): string {
  const archiveName = DWS_PLATFORM_ARCHIVES[`${process.platform}-${process.arch}`];
  if (!archiveName) {
    throw new Error(`DWS is not supported on ${process.platform}-${process.arch}`);
  }
  return archiveName;
}

async function extractDwsBinaryFromWindowsZip(archivePath: string, targetPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        reject(openError ?? new Error(`unable to open DWS archive ${archivePath}`));
        return;
      }

      let found = false;
      const fail = (error: unknown): void => {
        zipfile.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        const entryName = entry.fileName.replace(/\\/g, '/');
        if (found || entryName.toLowerCase().split('/').pop() !== 'dws.exe') {
          zipfile.readEntry();
          return;
        }

        found = true;
        zipfile.openReadStream(entry, (streamError, readStream) => {
          if (streamError || !readStream) {
            fail(streamError ?? new Error('unable to read DWS binary from archive'));
            return;
          }

          const chunks: Buffer[] = [];
          readStream.on('data', (chunk: Buffer) => chunks.push(chunk));
          readStream.on('error', fail);
          readStream.on('end', async () => {
            try {
              await fs.writeFile(targetPath, Buffer.concat(chunks));
              zipfile.close();
              resolve();
            } catch (error) {
              fail(error);
            }
          });
        });
      });
      zipfile.on('error', fail);
      zipfile.on('end', () => {
        if (!found) {
          reject(new Error(`DWS binary not found in archive ${archivePath}`));
        }
      });
    });
  });
}

async function findDwsBinaryInDirectory(root: string): Promise<string | null> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findDwsBinaryInDirectory(entryPath);
      if (nested) {
        return nested;
      }
      continue;
    }
    if (entry.name === 'dws' || entry.name === 'dws.exe') {
      return entryPath;
    }
  }
  return null;
}

async function ensureDwsBinaryInstalled(prefix: string): Promise<void> {
  const binaryPath = getDwsBinaryPath(prefix);
  if (await pathExists(binaryPath)) {
    return;
  }

  const packageRoot = getDwsPackageRoot(prefix);
  const archivePath = path.join(packageRoot, 'assets', getDwsArchiveName());
  if (!(await pathExists(archivePath))) {
    throw new Error(`DWS platform archive was not found: ${archivePath}`);
  }

  await fs.mkdir(path.dirname(binaryPath), { recursive: true });
  const stagingDirectory = await fs.mkdtemp(path.join(tmpdir(), 'aionui-dws-bin-'));
  const stagedBinaryPath = path.join(stagingDirectory, path.basename(binaryPath));
  try {
    if (process.platform === 'win32') {
      await extractDwsBinaryFromWindowsZip(archivePath, stagedBinaryPath);
    } else {
      await runCommand('tar', ['-xzf', archivePath, '-C', stagingDirectory], {
        timeout: OPENCODE_INSTALL_TIMEOUT_MS,
      });
      const extractedBinaryPath = await findDwsBinaryInDirectory(stagingDirectory);
      if (!extractedBinaryPath) {
        throw new Error(`DWS binary was not found in archive ${archivePath}`);
      }
      await fs.copyFile(extractedBinaryPath, stagedBinaryPath);
    }
    await fs.rename(stagedBinaryPath, binaryPath);
    if (process.platform !== 'win32') {
      await fs.chmod(binaryPath, 0o755);
    }
  } finally {
    await fs.rm(stagingDirectory, { force: true, recursive: true });
  }
}

async function ensureManagedToolInstalledWithManagedNode(options: {
  commandRunner: CommandRunner;
  dataPath: string;
  tool: ManagedAcpTool;
}): Promise<void> {
  const commandPath = getManagedToolCommandPath(options.tool, options.dataPath);
  const nodeExecutable = await findManagedNodeExecutable(options.dataPath);
  if (!nodeExecutable) {
    throw new Error('managed Node executable was not found');
  }

  const nodeBinDir = path.dirname(nodeExecutable);
  prependPathEntry(nodeBinDir);
  const prefix = getManagedToolNpmPrefix(options.tool, options.dataPath);
  if (await pathExists(commandPath)) {
    const packageIsReady = options.tool.toolId !== DWS_TOOL_ID || (await pathExists(getDwsBinaryPath(prefix)));
    if (packageIsReady) {
      await ensureManagedToolLauncherUsesManagedNode(options.tool, options.dataPath, nodeExecutable);
      return;
    }
  }

  const npmCliPath = getNpmCliPath(nodeExecutable);
  if (!(await pathExists(npmCliPath))) {
    throw new Error('managed npm CLI was not found');
  }

  await fs.mkdir(prefix, { recursive: true });
  const binDir = addManagedToolGlobalBinToPath(options.tool, options.dataPath);
  const commandEnv: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_prefix: prefix,
    npm_config_registry: MANAGED_NPM_REGISTRY,
    NPM_CONFIG_PREFIX: prefix,
    NPM_CONFIG_REGISTRY: MANAGED_NPM_REGISTRY,
    PATH: [binDir, nodeBinDir, process.env.PATH ?? process.env.Path ?? ''].filter(Boolean).join(path.delimiter),
  };
  if (options.tool.toolId === OPENCODE_TOOL_ID) {
    commandEnv.OPENCODE_CONFIG_DIR = getOpenCodeConfigDir(options.dataPath);
  }
  if (process.platform === 'win32') {
    commandEnv.Path = commandEnv.PATH;
  }

  await options.commandRunner(
    nodeExecutable,
    [
      npmCliPath,
      'install',
      '--global',
      options.tool.packageSpec ?? options.tool.packageName,
      '--prefix',
      prefix,
      '--registry',
      MANAGED_NPM_REGISTRY,
      ...(options.tool.toolId === DWS_TOOL_ID ? ['--ignore-scripts'] : []),
    ],
    {
      cwd: options.dataPath,
      env: commandEnv,
      timeout: OPENCODE_INSTALL_TIMEOUT_MS,
    }
  );

  if (options.tool.toolId === DWS_TOOL_ID) {
    await ensureDwsBinaryInstalled(prefix);
  }

  if (!(await pathExists(commandPath))) {
    throw new Error(`${options.tool.displayName} command was not created after installation`);
  }
  await ensureManagedToolLauncherUsesManagedNode(options.tool, options.dataPath, nodeExecutable);
}

function isCodexPluginInstalled(stdout: string | undefined, pluginId: string): boolean {
  if (!stdout) {
    return false;
  }

  try {
    const parsed = JSON.parse(stdout) as {
      installed?: Array<{ enabled?: boolean; installed?: boolean; pluginId?: string }>;
    };
    return (
      parsed.installed?.some(
        (plugin) => plugin.pluginId === pluginId && plugin.installed === true && plugin.enabled === true
      ) ?? false
    );
  } catch {
    return false;
  }
}

function isCodexMarketplaceConfigured(stdout: string | undefined, marketplaceName: string): boolean {
  if (!stdout) {
    return false;
  }

  try {
    const parsed = JSON.parse(stdout) as {
      marketplaces?: Array<{ name?: string }>;
    };
    return parsed.marketplaces?.some((marketplace) => marketplace.name === marketplaceName) ?? false;
  } catch {
    return false;
  }
}

function isCodexPluginAvailable(stdout: string | undefined, pluginId: string): boolean {
  if (!stdout) {
    return false;
  }

  try {
    const parsed = JSON.parse(stdout) as {
      available?: Array<{ pluginId?: string }>;
    };
    return parsed.available?.some((plugin) => plugin.pluginId === pluginId) ?? false;
  } catch {
    return false;
  }
}

async function ensureCodexPluginInstalled(options: {
  commandRunner: CommandRunner;
  dataPath: string;
  emitStatus: RuntimeStatusEmitter;
  plugin: CodexPluginSpec;
}): Promise<void> {
  const nodeExecutable = await findManagedNodeExecutable(options.dataPath);
  if (!nodeExecutable) {
    throw new Error('managed Node executable was not found');
  }

  const codexCliPath = await findManagedToolPackageBinTarget(CODEX_TOOL, options.dataPath);
  if (!codexCliPath || !(await pathExists(codexCliPath))) {
    throw new Error('managed Codex CLI entrypoint was not found');
  }

  const codexHome = getCodexHomeDir(options.dataPath);
  await fs.mkdir(codexHome, { recursive: true });

  const nodeBinDir = path.dirname(nodeExecutable);
  const codexBinDir = getManagedToolGlobalBinDir(CODEX_TOOL, options.dataPath);
  const commandEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    PATH: [codexBinDir, nodeBinDir, process.env.PATH ?? process.env.Path ?? ''].filter(Boolean).join(path.delimiter),
  };
  if (process.platform === 'win32') {
    commandEnv.Path = commandEnv.PATH;
  }

  const commandOptions = {
    cwd: options.dataPath,
    env: commandEnv,
    timeout: OPENCODE_INSTALL_TIMEOUT_MS,
  };
  const runCodex = (args: string[]) => options.commandRunner(nodeExecutable, [codexCliPath, ...args], commandOptions);

  emitToolRuntimeStatus(
    options.emitStatus,
    CODEX_TOOL,
    'validating',
    `Checking ${options.plugin.displayName} Codex plugin installation`
  );

  let pluginList: { stdout?: string } | undefined;
  try {
    pluginList = await runCodex(['plugin', 'list', '--marketplace', options.plugin.marketplaceName, '--json']);
  } catch {
    // A missing marketplace is represented as an empty list by current Codex versions.
    // Continue with the add flow for older versions that return a non-zero status here.
  }
  if (isCodexPluginInstalled(pluginList?.stdout, options.plugin.pluginId)) {
    emitToolRuntimeStatus(
      options.emitStatus,
      CODEX_TOOL,
      'ready',
      `${options.plugin.displayName} Codex plugin is ready`
    );
    return;
  }

  emitToolRuntimeStatus(
    options.emitStatus,
    CODEX_TOOL,
    'downloading',
    `Installing ${options.plugin.displayName} Codex plugin`
  );
  if (options.plugin.marketplaceUrl) {
    let marketplaceList: { stdout?: string } | undefined;
    try {
      marketplaceList = await runCodex(['plugin', 'marketplace', 'list', '--json']);
    } catch {
      // Keep supporting Codex versions that do not return a JSON marketplace list.
    }
    const marketplaceConfigured = isCodexMarketplaceConfigured(marketplaceList?.stdout, options.plugin.marketplaceName);
    if (!marketplaceConfigured) {
      try {
        await runCodex(['plugin', 'marketplace', 'add', options.plugin.marketplaceUrl]);
      } catch (error) {
        if (!normalizeError(error).includes(`marketplace '${options.plugin.marketplaceName}' is already added`)) {
          throw error;
        }
      }
    } else if (!isCodexPluginAvailable(pluginList?.stdout, options.plugin.pluginId)) {
      await runCodex(['plugin', 'marketplace', 'remove', options.plugin.marketplaceName]);
      await runCodex(['plugin', 'marketplace', 'add', options.plugin.marketplaceUrl]);
    }
  }
  try {
    await runCodex(['plugin', 'add', options.plugin.pluginId]);
  } catch (error) {
    if (
      !options.plugin.marketplaceUrl ||
      !normalizeError(error).includes(`was not found in marketplace '${options.plugin.marketplaceName}'`)
    ) {
      throw error;
    }
    await runCodex(['plugin', 'marketplace', 'remove', options.plugin.marketplaceName]);
    await runCodex(['plugin', 'marketplace', 'add', options.plugin.marketplaceUrl]);
    await runCodex(['plugin', 'add', options.plugin.pluginId]);
  }

  const verifiedPluginList = await runCodex([
    'plugin',
    'list',
    '--marketplace',
    options.plugin.marketplaceName,
    '--json',
  ]);
  if (!isCodexPluginInstalled(verifiedPluginList.stdout, options.plugin.pluginId)) {
    throw new Error(`${options.plugin.displayName} Codex plugin was not installed in ${codexHome}`);
  }

  emitToolRuntimeStatus(options.emitStatus, CODEX_TOOL, 'ready', `${options.plugin.displayName} Codex plugin is ready`);
}

function shouldEnsureManagedToolOnStartup(tool: ManagedAcpTool, env: OpenCodeStartupEnv = process.env): boolean {
  if (env[tool.envDisabledKey] === '0') {
    return false;
  }
  return env.AIONUI_E2E_TEST !== '1';
}

export function shouldEnsureOpenCodeOnStartup(env: OpenCodeStartupEnv = process.env): boolean {
  return shouldEnsureManagedToolOnStartup(OPENCODE_TOOL, env);
}

export function shouldEnsureBeisenCliOnStartup(env: OpenCodeStartupEnv = process.env): boolean {
  return shouldEnsureManagedToolOnStartup(BEISEN_CLI_TOOL, env);
}

export function shouldEnsureCodexOnStartup(env: OpenCodeStartupEnv = process.env): boolean {
  return shouldEnsureManagedToolOnStartup(CODEX_TOOL, env);
}

export function shouldEnsureDwsOnStartup(env: OpenCodeStartupEnv = process.env): boolean {
  return shouldEnsureManagedToolOnStartup(DWS_TOOL, env);
}

export function shouldEnsureGoogleWorkspaceCliOnStartup(env: OpenCodeStartupEnv = process.env): boolean {
  return shouldEnsureManagedToolOnStartup(GOOGLEWORKSPACE_CLI_TOOL, env);
}

export function shouldEnsureNoxinfluencerCliOnStartup(env: OpenCodeStartupEnv = process.env): boolean {
  return shouldEnsureManagedToolOnStartup(NOXINFLUENCER_CLI_TOOL, env);
}

export function shouldEnsureOfficeCliOnStartup(env: OpenCodeStartupEnv = process.env): boolean {
  return shouldEnsureManagedToolOnStartup(OFFICECLI_TOOL, env);
}

export function shouldEnsureShopifyCliOnStartup(env: OpenCodeStartupEnv = process.env): boolean {
  return shouldEnsureManagedToolOnStartup(SHOPIFY_CLI_TOOL, env);
}

export function shouldEnsureZiniaoOpenOnStartup(env: OpenCodeStartupEnv = process.env): boolean {
  return shouldEnsureManagedToolOnStartup(ZINIAO_OPEN_TOOL, env);
}

async function ensureManagedToolReady(
  tool: ManagedAcpTool,
  options: EnsureOpenCodeReadyOptions = {}
): Promise<OpenCodeBootstrapResult> {
  const env = options.env ?? process.env;
  if (!shouldEnsureManagedToolOnStartup(tool, env)) {
    return { status: 'skipped' };
  }

  const scope = options.scope ?? tool.scope;
  const scopedTool = scope === tool.scope ? tool : { ...tool, scope };
  const dataPath = options.dataPath ?? getDataPath();
  const emitStatus = options.emitStatus ?? ipcBridge.runtime.localStatusChanged.emit;
  const ensureNodeRuntime = options.ensureNodeRuntime ?? ipcBridge.systemSettings.ensureNodeRuntime.invoke;
  const commandRunner = options.commandRunner ?? runCommand;
  const packageName = options.packageName ?? tool.packageName;

  try {
    addManagedToolGlobalBinToPath(scopedTool, dataPath);
    const commandPath = getManagedToolCommandPath(scopedTool, dataPath);
    const hadTool = await pathExists(commandPath);
    emitToolRuntimeStatus(
      emitStatus,
      scopedTool,
      hadTool ? 'validating' : 'downloading',
      hadTool ? `Checking ${tool.displayName} installation` : `Installing ${tool.displayName} with managed Node runtime`
    );

    const nodeResult = await ensureNodeRuntime({ scope });
    if (nodeResult.ready !== true) {
      emitToolRuntimeStatus(emitStatus, scopedTool, 'failed', 'managed Node runtime is not ready');
      return { status: 'failed', error: 'managed Node runtime is not ready' };
    }

    await ensureManagedToolInstalledWithManagedNode({
      commandRunner,
      dataPath,
      tool: {
        ...scopedTool,
        packageName,
      },
    });
    emitToolRuntimeStatus(emitStatus, scopedTool, 'ready', `${tool.displayName} is ready`);

    return { status: 'ready' };
  } catch (error) {
    const normalizedError = normalizeError(error);
    emitToolRuntimeStatus(emitStatus, scopedTool, 'failed', normalizedError);
    return {
      status: 'failed',
      error: normalizedError,
    };
  }
}

export function ensureOpenCodeReady(options: EnsureOpenCodeReadyOptions = {}): Promise<OpenCodeBootstrapResult> {
  return ensureManagedToolReady(OPENCODE_TOOL, options);
}

export function ensureBeisenCliReady(options: EnsureOpenCodeReadyOptions = {}): Promise<OpenCodeBootstrapResult> {
  return ensureManagedToolReady(BEISEN_CLI_TOOL, options);
}

export function ensureCodexReady(options: EnsureOpenCodeReadyOptions = {}): Promise<OpenCodeBootstrapResult> {
  return ensureManagedToolReady(CODEX_TOOL, options);
}

export function ensureDwsReady(options: EnsureOpenCodeReadyOptions = {}): Promise<OpenCodeBootstrapResult> {
  return ensureManagedToolReady(DWS_TOOL, options);
}

export function ensureGoogleWorkspaceCliReady(
  options: EnsureOpenCodeReadyOptions = {}
): Promise<OpenCodeBootstrapResult> {
  return ensureManagedToolReady(GOOGLEWORKSPACE_CLI_TOOL, options);
}

export function ensureNoxinfluencerCliReady(
  options: EnsureOpenCodeReadyOptions = {}
): Promise<OpenCodeBootstrapResult> {
  return ensureManagedToolReady(NOXINFLUENCER_CLI_TOOL, options);
}

export function ensureOfficeCliReady(options: EnsureOpenCodeReadyOptions = {}): Promise<OpenCodeBootstrapResult> {
  return ensureManagedToolReady(OFFICECLI_TOOL, options);
}

export function ensureShopifyCliReady(options: EnsureOpenCodeReadyOptions = {}): Promise<OpenCodeBootstrapResult> {
  return ensureManagedToolReady(SHOPIFY_CLI_TOOL, options);
}

export function ensureZiniaoOpenReady(options: EnsureOpenCodeReadyOptions = {}): Promise<OpenCodeBootstrapResult> {
  return ensureManagedToolReady(ZINIAO_OPEN_TOOL, options);
}

export function ensureOpenCodeReadyOnce(options: EnsureOpenCodeReadyOptions = {}): Promise<OpenCodeBootstrapResult> {
  if (!startupPromise) {
    startupPromise = ensureOpenCodeReady(options);
  }
  return startupPromise;
}

export async function ensureOpenCodeReadyOnStartup(
  options: EnsureOpenCodeReadyOptions = {}
): Promise<OpenCodeBootstrapResult> {
  const result = await ensureOpenCodeReadyOnce(options);
  switch (result.status) {
    case 'ready':
      console.info('[OpenCode] managed runtime is ready');
      break;
    case 'skipped':
      console.info('[OpenCode] startup bootstrap skipped');
      break;
    case 'failed':
      console.warn('[OpenCode] managed runtime bootstrap failed:', result.error);
      break;
  }
  return result;
}

export async function ensureBeisenCliReadyOnStartup(
  options: EnsureOpenCodeReadyOptions = {}
): Promise<OpenCodeBootstrapResult> {
  const result = await ensureBeisenCliReady(options);
  switch (result.status) {
    case 'ready':
      console.info('[Beisen CLI] managed runtime is ready');
      break;
    case 'skipped':
      console.info('[Beisen CLI] startup bootstrap skipped');
      break;
    case 'failed':
      console.warn('[Beisen CLI] managed runtime bootstrap failed:', result.error);
      break;
  }
  return result;
}

export async function ensureCodexReadyOnStartup(
  options: EnsureOpenCodeReadyOptions = {}
): Promise<OpenCodeBootstrapResult> {
  let result = await ensureCodexReady(options);
  if (result.status === 'ready') {
    const pluginOptions = {
      commandRunner: options.commandRunner ?? runCommand,
      dataPath: options.dataPath ?? getDataPath(),
      emitStatus: options.emitStatus ?? ipcBridge.runtime.localStatusChanged.emit,
    };
    let pluginError: string | undefined;
    for (const plugin of [CHATCUT_PLUGIN_SPEC, ADSPIRER_PLUGIN_SPEC, SHOPIFY_PLUGIN_SPEC]) {
      try {
        await ensureCodexPluginInstalled({ ...pluginOptions, plugin });
      } catch (error) {
        const normalizedError = normalizeError(error);
        pluginError ??= normalizedError;
        emitToolRuntimeStatus(pluginOptions.emitStatus, CODEX_TOOL, 'failed', normalizedError);
      }
    }
    if (pluginError) {
      result = { status: 'failed', error: pluginError };
    }
  }

  switch (result.status) {
    case 'ready':
      console.info('[Codex] managed runtime, ChatCut, Adspirer, and Shopify plugins are ready');
      break;
    case 'skipped':
      console.info('[Codex] startup bootstrap skipped');
      break;
    case 'failed':
      console.warn('[Codex] managed runtime bootstrap failed:', result.error);
      break;
  }
  return result;
}

export async function ensureDwsReadyOnStartup(
  options: EnsureOpenCodeReadyOptions = {}
): Promise<OpenCodeBootstrapResult> {
  const result = await ensureDwsReady(options);
  switch (result.status) {
    case 'ready':
      console.info('[DingTalk DWS] managed runtime is ready');
      break;
    case 'skipped':
      console.info('[DingTalk DWS] startup bootstrap skipped');
      break;
    case 'failed':
      console.warn('[DingTalk DWS] managed runtime bootstrap failed:', result.error);
      break;
  }
  return result;
}

export async function ensureGoogleWorkspaceCliReadyOnStartup(
  options: EnsureOpenCodeReadyOptions = {}
): Promise<OpenCodeBootstrapResult> {
  const result = await ensureGoogleWorkspaceCliReady(options);
  switch (result.status) {
    case 'ready':
      console.info('[Google Workspace CLI] managed runtime is ready');
      break;
    case 'skipped':
      console.info('[Google Workspace CLI] startup bootstrap skipped');
      break;
    case 'failed':
      console.warn('[Google Workspace CLI] managed runtime bootstrap failed:', result.error);
      break;
  }
  return result;
}

export async function ensureNoxinfluencerCliReadyOnStartup(
  options: EnsureOpenCodeReadyOptions = {}
): Promise<OpenCodeBootstrapResult> {
  const result = await ensureNoxinfluencerCliReady(options);
  switch (result.status) {
    case 'ready':
      console.info('[Noxinfluencer CLI] managed runtime is ready');
      break;
    case 'skipped':
      console.info('[Noxinfluencer CLI] startup bootstrap skipped');
      break;
    case 'failed':
      console.warn('[Noxinfluencer CLI] managed runtime bootstrap failed:', result.error);
      break;
  }
  return result;
}

export async function ensureOfficeCliReadyOnStartup(
  options: EnsureOpenCodeReadyOptions = {}
): Promise<OpenCodeBootstrapResult> {
  const result = await ensureOfficeCliReady(options);
  switch (result.status) {
    case 'ready':
      console.info('[OfficeCLI] managed runtime is ready');
      break;
    case 'skipped':
      console.info('[OfficeCLI] startup bootstrap skipped');
      break;
    case 'failed':
      console.warn('[OfficeCLI] managed runtime bootstrap failed:', result.error);
      break;
  }
  return result;
}

export async function ensureShopifyCliReadyOnStartup(
  options: EnsureOpenCodeReadyOptions = {}
): Promise<OpenCodeBootstrapResult> {
  const result = await ensureShopifyCliReady(options);
  switch (result.status) {
    case 'ready':
      console.info('[Shopify CLI] managed runtime is ready');
      break;
    case 'skipped':
      console.info('[Shopify CLI] startup bootstrap skipped');
      break;
    case 'failed':
      console.warn('[Shopify CLI] managed runtime bootstrap failed:', result.error);
      break;
  }
  return result;
}

export async function ensureZiniaoOpenReadyOnStartup(
  options: EnsureOpenCodeReadyOptions = {}
): Promise<OpenCodeBootstrapResult> {
  const result = await ensureZiniaoOpenReady(options);
  switch (result.status) {
    case 'ready':
      console.info('[Ziniao Open] managed CLI is ready');
      break;
    case 'skipped':
      console.info('[Ziniao Open] startup bootstrap skipped');
      break;
    case 'failed':
      console.warn('[Ziniao Open] managed CLI bootstrap failed:', result.error);
      break;
  }
  return result;
}

export async function checkOpenCodeManagedAgentHealth(
  options: CheckOpenCodeManagedAgentHealthOptions
): Promise<OpenCodeManagedAgentHealthResult> {
  if (!isReadyForManagedAgentHealthCheck(options.bootstrapResult)) {
    return { checked: false };
  }
  if (!Number.isFinite(options.backendPort) || options.backendPort <= 0) {
    return { checked: false, error: 'backend port is not available' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const baseUrl = `http://127.0.0.1:${options.backendPort}`;

  try {
    const rows = await fetchJsonWithTimeout<ManagedAgentRow[]>(
      fetchImpl,
      `${baseUrl}/api/agents/management`,
      { method: 'GET' },
      timeoutMs
    );
    const agent = findManagedAgent(Array.isArray(rows) ? rows : [], OPENCODE_TOOL.match);
    if (!agent?.id) {
      return { checked: false, error: 'opencode managed agent was not found' };
    }
    await ensureManagedAgentEnvOverride(agent.id, 'OPENCODE_CONFIG_DIR', getOpenCodeConfigDir());
    const health = await fetchJsonWithTimeout<ManagedAgentRow>(
      fetchImpl,
      `${baseUrl}/api/agents/${encodeURIComponent(agent.id)}/health-check`,
      {
        method: 'POST',
      },
      timeoutMs
    );
    return {
      checked: true,
      agentId: agent.id,
      status: health.status,
    };
  } catch (error) {
    return {
      checked: false,
      error: normalizeError(error),
    };
  }
}

export async function checkCodexManagedAgentHealth(
  options: CheckOpenCodeManagedAgentHealthOptions
): Promise<OpenCodeManagedAgentHealthResult> {
  if (!isReadyForManagedAgentHealthCheck(options.bootstrapResult)) {
    return { checked: false };
  }
  if (!Number.isFinite(options.backendPort) || options.backendPort <= 0) {
    return { checked: false, error: 'backend port is not available' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const baseUrl = `http://127.0.0.1:${options.backendPort}`;

  try {
    const rows = await fetchJsonWithTimeout<ManagedAgentRow[]>(
      fetchImpl,
      `${baseUrl}/api/agents/management`,
      { method: 'GET' },
      timeoutMs
    );
    const agent = findManagedAgent(Array.isArray(rows) ? rows : [], CODEX_TOOL.match);
    if (!agent?.id) {
      return { checked: false, error: 'codex managed agent was not found' };
    }
    await ensureManagedAgentEnvOverride(agent.id, 'CODEX_HOME', getCodexHomeDir());
    const health = await fetchJsonWithTimeout<ManagedAgentRow>(
      fetchImpl,
      `${baseUrl}/api/agents/${encodeURIComponent(agent.id)}/health-check`,
      {
        method: 'POST',
      },
      timeoutMs
    );
    return {
      checked: true,
      agentId: agent.id,
      status: health.status,
    };
  } catch (error) {
    return {
      checked: false,
      error: normalizeError(error),
    };
  }
}

export async function checkDwsManagedAgentHealth(
  options: CheckOpenCodeManagedAgentHealthOptions
): Promise<OpenCodeManagedAgentHealthResult> {
  if (!isReadyForManagedAgentHealthCheck(options.bootstrapResult)) {
    return { checked: false };
  }
  if (!Number.isFinite(options.backendPort) || options.backendPort <= 0) {
    return { checked: false, error: 'backend port is not available' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const baseUrl = `http://127.0.0.1:${options.backendPort}`;

  try {
    const rows = await fetchJsonWithTimeout<ManagedAgentRow[]>(
      fetchImpl,
      `${baseUrl}/api/agents/management`,
      { method: 'GET' },
      timeoutMs
    );
    const agent = findManagedAgent(Array.isArray(rows) ? rows : [], DWS_TOOL.match);
    if (!agent?.id) {
      return { checked: false, error: 'dingtalk dws managed agent was not found' };
    }
    const health = await fetchJsonWithTimeout<ManagedAgentRow>(
      fetchImpl,
      `${baseUrl}/api/agents/${encodeURIComponent(agent.id)}/health-check`,
      {
        method: 'POST',
      },
      timeoutMs
    );
    return {
      checked: true,
      agentId: agent.id,
      status: health.status,
    };
  } catch (error) {
    return {
      checked: false,
      error: normalizeError(error),
    };
  }
}

export async function checkOfficeCliManagedAgentHealth(
  options: CheckOpenCodeManagedAgentHealthOptions
): Promise<OpenCodeManagedAgentHealthResult> {
  if (!isReadyForManagedAgentHealthCheck(options.bootstrapResult)) {
    return { checked: false };
  }
  if (!Number.isFinite(options.backendPort) || options.backendPort <= 0) {
    return { checked: false, error: 'backend port is not available' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const baseUrl = `http://127.0.0.1:${options.backendPort}`;

  try {
    const rows = await fetchJsonWithTimeout<ManagedAgentRow[]>(
      fetchImpl,
      `${baseUrl}/api/agents/management`,
      { method: 'GET' },
      timeoutMs
    );
    const agent = findManagedAgent(Array.isArray(rows) ? rows : [], OFFICECLI_TOOL.match);
    if (!agent?.id) {
      return { checked: false, error: 'officecli managed agent was not found' };
    }
    const health = await fetchJsonWithTimeout<ManagedAgentRow>(
      fetchImpl,
      `${baseUrl}/api/agents/${encodeURIComponent(agent.id)}/health-check`,
      {
        method: 'POST',
      },
      timeoutMs
    );
    return {
      checked: true,
      agentId: agent.id,
      status: health.status,
    };
  } catch (error) {
    return {
      checked: false,
      error: normalizeError(error),
    };
  }
}

export async function checkOpenCodeManagedAgentHealthOnStartup(
  options: CheckOpenCodeManagedAgentHealthOptions
): Promise<OpenCodeManagedAgentHealthResult> {
  const result = await checkOpenCodeManagedAgentHealth(options);
  if (result.checked) {
    console.info(
      `[OpenCode] managed agent health-check completed (id=${result.agentId}, status=${result.status ?? 'unknown'})`
    );
  } else if (result.error) {
    console.warn('[OpenCode] managed agent health-check skipped or failed:', result.error);
  }
  return result;
}

export async function checkCodexManagedAgentHealthOnStartup(
  options: CheckOpenCodeManagedAgentHealthOptions
): Promise<OpenCodeManagedAgentHealthResult> {
  const result = await checkCodexManagedAgentHealth(options);
  if (result.checked) {
    console.info(
      `[Codex] managed agent health-check completed (id=${result.agentId}, status=${result.status ?? 'unknown'})`
    );
  } else if (result.error) {
    console.warn('[Codex] managed agent health-check skipped or failed:', result.error);
  }
  return result;
}

export async function checkDwsManagedAgentHealthOnStartup(
  options: CheckOpenCodeManagedAgentHealthOptions
): Promise<OpenCodeManagedAgentHealthResult> {
  const result = await checkDwsManagedAgentHealth(options);
  if (result.checked) {
    console.info(
      `[DingTalk DWS] managed agent health-check completed (id=${result.agentId}, status=${result.status ?? 'unknown'})`
    );
  } else if (result.error) {
    console.warn('[DingTalk DWS] managed agent health-check skipped or failed:', result.error);
  }
  return result;
}

export async function checkOfficeCliManagedAgentHealthOnStartup(
  options: CheckOpenCodeManagedAgentHealthOptions
): Promise<OpenCodeManagedAgentHealthResult> {
  const result = await checkOfficeCliManagedAgentHealth(options);
  if (result.checked) {
    console.info(
      `[OfficeCLI] managed agent health-check completed (id=${result.agentId}, status=${result.status ?? 'unknown'})`
    );
  } else if (result.error) {
    console.warn('[OfficeCLI] managed agent health-check skipped or failed:', result.error);
  }
  return result;
}
