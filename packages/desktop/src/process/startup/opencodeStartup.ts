/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IRuntimeStatusEvent, IRuntimeStatusScope } from '@/common/adapter/ipcBridge';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
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
    | 'AIONUI_CODEX_BOOTSTRAP'
    | 'AIONUI_DWS_BOOTSTRAP'
    | 'AIONUI_OFFICECLI_BOOTSTRAP'
    | 'AIONUI_OPENCODE_BOOTSTRAP'
    | 'AIONUI_ZINIAO_OPEN_BOOTSTRAP';
  match: string | readonly string[];
  packageName: string;
  scope: IRuntimeStatusScope;
  toolId: 'codex' | 'dws' | 'officecli' | 'opencode' | 'ziniao-open';
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
  AIONUI_CODEX_BOOTSTRAP?: string;
  AIONUI_DWS_BOOTSTRAP?: string;
  AIONUI_OFFICECLI_BOOTSTRAP?: string;
  AIONUI_E2E_TEST?: string;
  AIONUI_OPENCODE_BOOTSTRAP?: string;
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
const CODEX_TOOL_ID = 'codex';
const CODEX_PACKAGE_NAME = '@openai/codex';
const CODEX_AGENT_MATCH = 'codex';
const CODEX_STARTUP_SCOPE: IRuntimeStatusScope = {
  kind: 'custom_agent',
  id: 'startup-codex',
};
const DWS_TOOL_ID = 'dws';
const DWS_COMMAND_NAME = 'dws';
const DWS_PACKAGE_NAME = 'dingtalk-workspace-cli';
const DWS_AGENT_MATCH = ['monoskill', 'dws', 'dingtalk'] as const;
const DWS_STARTUP_SCOPE: IRuntimeStatusScope = {
  kind: 'custom_agent',
  id: 'startup-dws',
};
const OFFICECLI_TOOL_ID = 'officecli';
const OFFICECLI_PACKAGE_NAME = '@officecli/officecli';
const OFFICECLI_AGENT_MATCH = 'officecli';
const OFFICECLI_STARTUP_SCOPE: IRuntimeStatusScope = {
  kind: 'custom_agent',
  id: 'startup-officecli',
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

const OPENCODE_TOOL: ManagedAcpTool = {
  commandName: OPENCODE_TOOL_ID,
  displayName: 'OpenCode',
  envDisabledKey: 'AIONUI_OPENCODE_BOOTSTRAP',
  match: OPENCODE_AGENT_MATCH,
  packageName: OPENCODE_PACKAGE_NAME,
  scope: OPENCODE_STARTUP_SCOPE,
  toolId: OPENCODE_TOOL_ID,
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

const OFFICECLI_TOOL: ManagedAcpTool = {
  commandName: OFFICECLI_TOOL_ID,
  displayName: 'OfficeCLI',
  envDisabledKey: 'AIONUI_OFFICECLI_BOOTSTRAP',
  match: OFFICECLI_AGENT_MATCH,
  packageName: OFFICECLI_PACKAGE_NAME,
  scope: OFFICECLI_STARTUP_SCOPE,
  toolId: OFFICECLI_TOOL_ID,
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

const STARTUP_TOOLS = [OPENCODE_TOOL, CODEX_TOOL, DWS_TOOL, OFFICECLI_TOOL, ZINIAO_OPEN_TOOL] as const;

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

function getCodexHomeDir(): string {
  return path.join(getSystemDir().workDir, 'runtime', 'codex-home');
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

export function addCodexGlobalBinToPath(dataPath = getDataPath(), env: NodeJS.ProcessEnv = process.env): string {
  return addManagedToolGlobalBinToPath(CODEX_TOOL, dataPath, env);
}

export function addDwsGlobalBinToPath(dataPath = getDataPath(), env: NodeJS.ProcessEnv = process.env): string {
  return addManagedToolGlobalBinToPath(DWS_TOOL, dataPath, env);
}

export function addOfficeCliGlobalBinToPath(dataPath = getDataPath(), env: NodeJS.ProcessEnv = process.env): string {
  return addManagedToolGlobalBinToPath(OFFICECLI_TOOL, dataPath, env);
}

export function addZiniaoOpenGlobalBinToPath(dataPath = getDataPath(), env: NodeJS.ProcessEnv = process.env): string {
  return addManagedToolGlobalBinToPath(ZINIAO_OPEN_TOOL, dataPath, env);
}

export function addStartupManagedAcpToolBinsToPath(
  dataPath = getDataPath(),
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const tool of STARTUP_TOOLS) {
    addManagedToolGlobalBinToPath(tool, dataPath, env);
  }
}

function getManagedToolCommandPath(tool: ManagedAcpTool, dataPath = getDataPath()): string {
  const binDir = getManagedToolGlobalBinDir(tool, dataPath);
  return path.join(binDir, process.platform === 'win32' ? `${tool.commandName}.cmd` : tool.commandName);
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

async function ensureManagedToolInstalledWithManagedNode(options: {
  commandRunner: CommandRunner;
  dataPath: string;
  tool: ManagedAcpTool;
}): Promise<void> {
  const commandPath = getManagedToolCommandPath(options.tool, options.dataPath);
  if (await pathExists(commandPath)) {
    return;
  }

  const nodeExecutable = await findManagedNodeExecutable(options.dataPath);
  if (!nodeExecutable) {
    throw new Error('managed Node executable was not found');
  }

  const npmCliPath = getNpmCliPath(nodeExecutable);
  if (!(await pathExists(npmCliPath))) {
    throw new Error('managed npm CLI was not found');
  }

  const prefix = getManagedToolNpmPrefix(options.tool, options.dataPath);
  await fs.mkdir(prefix, { recursive: true });
  const binDir = addManagedToolGlobalBinToPath(options.tool, options.dataPath);
  const commandEnv: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_prefix: prefix,
    npm_config_registry: MANAGED_NPM_REGISTRY,
    NPM_CONFIG_PREFIX: prefix,
    NPM_CONFIG_REGISTRY: MANAGED_NPM_REGISTRY,
    PATH: [binDir, process.env.PATH ?? process.env.Path ?? ''].filter(Boolean).join(path.delimiter),
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
      options.tool.packageName,
      '--prefix',
      prefix,
      '--registry',
      MANAGED_NPM_REGISTRY,
    ],
    {
      cwd: options.dataPath,
      env: commandEnv,
      timeout: OPENCODE_INSTALL_TIMEOUT_MS,
    }
  );

  if (!(await pathExists(commandPath))) {
    throw new Error(`${options.tool.displayName} command was not created after installation`);
  }
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

export function shouldEnsureCodexOnStartup(env: OpenCodeStartupEnv = process.env): boolean {
  return shouldEnsureManagedToolOnStartup(CODEX_TOOL, env);
}

export function shouldEnsureDwsOnStartup(env: OpenCodeStartupEnv = process.env): boolean {
  return shouldEnsureManagedToolOnStartup(DWS_TOOL, env);
}

export function shouldEnsureOfficeCliOnStartup(env: OpenCodeStartupEnv = process.env): boolean {
  return shouldEnsureManagedToolOnStartup(OFFICECLI_TOOL, env);
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

export function ensureCodexReady(options: EnsureOpenCodeReadyOptions = {}): Promise<OpenCodeBootstrapResult> {
  return ensureManagedToolReady(CODEX_TOOL, options);
}

export function ensureDwsReady(options: EnsureOpenCodeReadyOptions = {}): Promise<OpenCodeBootstrapResult> {
  return ensureManagedToolReady(DWS_TOOL, options);
}

export function ensureOfficeCliReady(options: EnsureOpenCodeReadyOptions = {}): Promise<OpenCodeBootstrapResult> {
  return ensureManagedToolReady(OFFICECLI_TOOL, options);
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

export async function ensureCodexReadyOnStartup(
  options: EnsureOpenCodeReadyOptions = {}
): Promise<OpenCodeBootstrapResult> {
  const result = await ensureCodexReady(options);
  switch (result.status) {
    case 'ready':
      console.info('[Codex] managed runtime is ready');
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
