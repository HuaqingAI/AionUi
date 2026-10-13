/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import type {
  IRuntimeStatusEvent,
  RuntimeDiagnosticBatchInstallResult,
  RuntimeDiagnosticItem,
  RuntimeDiagnosticStatus,
} from '@/common/adapter/ipcBridge';
import {
  buildManagedStartupToolEnvForDiagnostics,
  ensureManagedStartupToolReadyForDiagnostics,
  getManagedStartupToolCommandInvocationForDiagnostics,
  getManagedStartupToolDwsBinaryPathForDiagnostics,
  readManagedStartupToolPackageVersionForDiagnostics,
  type EnsureOpenCodeReadyOptions,
  type ManagedStartupToolId,
  type OpenCodeBootstrapResult,
} from '@process/startup/opencodeStartup';
import {
  addManagedUvBinsToPath,
  ensureManagedPython,
  ensureUvReady,
  findManagedPythonForDiagnostics,
  getManagedPythonInstallDirectoryForDiagnostics,
  getUvExecutablePathForDiagnostics,
  isManagedPythonCommandDirectorySafeForDiagnostics,
  type EnsureManagedPythonOptions,
  type EnsureUvReadyOptions,
  type ManagedPythonBootstrapResult,
  type UvBootstrapResult,
} from '@process/startup/uvStartup';
import { getRuntimeDiagnosticDefinitions } from './catalog';
import type { DiagnosticCommandRunner, RuntimeDiagnosticDefinition } from './types';

const VERSION_CHECK_TIMEOUT_MS = 30000;
const execFileAsync = promisify(execFile);

type RuntimeDiagnosticsServiceOptions = {
  commandRunner?: DiagnosticCommandRunner;
  dataPath: string;
  emitDiagnosticsStatus?: (item: RuntimeDiagnosticItem) => void;
  emitRuntimeStatus?: (event: IRuntimeStatusEvent) => void;
  ensureManagedPythonRuntime?: (options?: EnsureManagedPythonOptions) => Promise<ManagedPythonBootstrapResult>;
  ensureManagedToolReady?: (
    toolId: ManagedStartupToolId,
    options?: EnsureOpenCodeReadyOptions
  ) => Promise<OpenCodeBootstrapResult>;
  ensureUvRuntime?: (options?: EnsureUvReadyOptions) => Promise<UvBootstrapResult>;
  now?: () => number;
};

async function defaultCommandRunner(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    windowsVerbatimArguments?: boolean;
  }
): Promise<{ stderr?: string; stdout?: string }> {
  const { stderr, stdout } = await execFileAsync(file, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    windowsHide: true,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
  });
  return {
    stderr: typeof stderr === 'string' ? stderr : undefined,
    stdout: typeof stdout === 'string' ? stdout : undefined,
  };
}

async function pathExists(filePath: string | null | undefined): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeCommandOutput(stdout?: string, stderr?: string): string {
  return `${stdout ?? ''}\n${stderr ?? ''}`.trim().split(/\r?\n/).slice(0, 20).join('\n').slice(0, 2048);
}

function sanitizeRuntimeText(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  let text = raw;
  for (const home of [process.env.HOME, process.env.USERPROFILE].filter((item): item is string => Boolean(item))) {
    text = text.replaceAll(home, '~');
  }
  return text.replace(/(authorization|api[_-]?key|token)\s*[:=]\s*[^,\s]+/gi, '$1=<redacted>').slice(0, 2048);
}

function createGuidance(status: RuntimeDiagnosticStatus): string | undefined {
  if (status === 'missing') {
    return 'The managed command file was not found. Click install/repair to recreate it.';
  }
  if (status === 'broken') {
    return 'The command exists but failed validation. Click install/repair to reinstall it.';
  }
  if (status === 'failed') {
    return 'The diagnostic operation failed. Check the network or permissions and retry.';
  }
  if (status === 'unsupported') {
    return 'This managed runtime is not supported on the current platform.';
  }
  return undefined;
}

function isUnavailable(status: RuntimeDiagnosticStatus): boolean {
  return status === 'missing' || status === 'broken' || status === 'failed';
}

export class RuntimeDiagnosticsService {
  private readonly commandRunner: DiagnosticCommandRunner;
  private readonly dataPath: string;
  private readonly definitions = getRuntimeDiagnosticDefinitions();
  private readonly emitDiagnosticsStatus?: (item: RuntimeDiagnosticItem) => void;
  private readonly emitRuntimeStatus?: (event: IRuntimeStatusEvent) => void;
  private readonly ensureManagedPythonRuntime: (
    options?: EnsureManagedPythonOptions
  ) => Promise<ManagedPythonBootstrapResult>;
  private readonly ensureManagedToolReady: (
    toolId: ManagedStartupToolId,
    options?: EnsureOpenCodeReadyOptions
  ) => Promise<OpenCodeBootstrapResult>;
  private readonly ensureUvRuntime: (options?: EnsureUvReadyOptions) => Promise<UvBootstrapResult>;
  private readonly installPromises = new Map<string, Promise<RuntimeDiagnosticItem>>();
  private readonly latest = new Map<string, RuntimeDiagnosticItem>();
  private readonly now: () => number;
  private readonly probePromises = new Map<string, Promise<RuntimeDiagnosticItem>>();

  constructor(options: RuntimeDiagnosticsServiceOptions) {
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.dataPath = options.dataPath;
    this.emitDiagnosticsStatus = options.emitDiagnosticsStatus;
    this.emitRuntimeStatus = options.emitRuntimeStatus;
    this.ensureManagedPythonRuntime = options.ensureManagedPythonRuntime ?? ensureManagedPython;
    this.ensureManagedToolReady = options.ensureManagedToolReady ?? ensureManagedStartupToolReadyForDiagnostics;
    this.ensureUvRuntime = options.ensureUvRuntime ?? ensureUvReady;
    this.now = options.now ?? Date.now;
  }

  list(): RuntimeDiagnosticItem[] {
    return this.definitions.map((definition) => this.latest.get(definition.id) ?? this.createBaseItem(definition));
  }

  async probe(ids?: string[]): Promise<RuntimeDiagnosticItem[]> {
    const definitions = this.resolveDefinitions(ids);
    return Promise.all(definitions.map((definition) => this.probeOne(definition)));
  }

  async install(ids: string[]): Promise<RuntimeDiagnosticBatchInstallResult> {
    const definitions = this.resolveDefinitions(ids);
    const items: RuntimeDiagnosticItem[] = [];
    for (const definition of definitions) {
      // eslint-disable-next-line no-await-in-loop -- installs are intentionally serialized to avoid competing npm/uv work.
      items.push(await this.installOne(definition));
    }
    return {
      failedIds: items.filter((item) => isUnavailable(item.status)).map((item) => item.id),
      items,
    };
  }

  private createBaseItem(definition: RuntimeDiagnosticDefinition): RuntimeDiagnosticItem {
    let expectedPath: string | undefined;
    try {
      expectedPath = definition.resolveExpectedPath(this.dataPath) ?? undefined;
    } catch (error) {
      return {
        args: definition.args,
        command: definition.command,
        error: sanitizeRuntimeText(error),
        guidance: createGuidance('unsupported'),
        id: definition.id,
        installable: false,
        kind: definition.kind,
        label: definition.label,
        packageName: definition.packageName,
        packageSpec: definition.packageSpec,
        requiredVersion: definition.requiredVersion,
        status: 'unsupported',
      };
    }

    return {
      args: definition.args,
      command: definition.command,
      expectedPath,
      id: definition.id,
      installable: definition.installable,
      kind: definition.kind,
      label: definition.label,
      packageName: definition.packageName,
      packageSpec: definition.packageSpec,
      requiredVersion: definition.requiredVersion,
      status: 'unknown',
    };
  }

  private createCompletedItem(
    definition: RuntimeDiagnosticDefinition,
    status: RuntimeDiagnosticStatus,
    startedAt: number,
    update: Partial<RuntimeDiagnosticItem> = {}
  ): RuntimeDiagnosticItem {
    const item = {
      ...this.createBaseItem(definition),
      ...update,
      durationMs: this.now() - startedAt,
      guidance: update.guidance ?? createGuidance(status),
      lastCheckedAt: this.now(),
      status,
    };
    return this.publish(item);
  }

  private createProgressItem(
    definition: RuntimeDiagnosticDefinition,
    status: 'checking' | 'installing'
  ): RuntimeDiagnosticItem {
    return this.publish({
      ...this.createBaseItem(definition),
      ...this.latest.get(definition.id),
      status,
    });
  }

  private async installOne(definition: RuntimeDiagnosticDefinition): Promise<RuntimeDiagnosticItem> {
    const existing = this.installPromises.get(definition.id);
    if (existing) {
      return existing;
    }

    const installPromise = this.runInstall(definition);
    this.installPromises.set(definition.id, installPromise);
    try {
      return await installPromise;
    } finally {
      if (this.installPromises.get(definition.id) === installPromise) {
        this.installPromises.delete(definition.id);
      }
    }
  }

  private publish(item: RuntimeDiagnosticItem): RuntimeDiagnosticItem {
    this.latest.set(item.id, item);
    this.emitDiagnosticsStatus?.(item);
    return item;
  }

  private async probeManagedNodeTool(
    definition: RuntimeDiagnosticDefinition,
    expectedPath: string,
    startedAt: number
  ): Promise<RuntimeDiagnosticItem> {
    const toolId = definition.toolId;
    if (!toolId) {
      return this.createCompletedItem(definition, 'failed', startedAt, {
        error: 'managed tool id is missing',
      });
    }

    if (!(await pathExists(expectedPath))) {
      return this.createCompletedItem(definition, 'missing', startedAt, {
        error: 'managed command file is missing',
      });
    }

    if (definition.requiredVersion) {
      const packageVersion = await readManagedStartupToolPackageVersionForDiagnostics(toolId, this.dataPath);
      if (packageVersion !== definition.requiredVersion) {
        return this.createCompletedItem(definition, 'broken', startedAt, {
          error: packageVersion
            ? `managed package version is ${packageVersion}, expected ${definition.requiredVersion}`
            : 'managed package version could not be read',
          resolvedPath: expectedPath,
        });
      }
    }

    const dwsBinaryPath = getManagedStartupToolDwsBinaryPathForDiagnostics(toolId, this.dataPath);
    if (dwsBinaryPath && !(await pathExists(dwsBinaryPath))) {
      return this.createCompletedItem(definition, 'broken', startedAt, {
        error: 'DWS vendor binary is missing',
        resolvedPath: expectedPath,
      });
    }

    const env = buildManagedStartupToolEnvForDiagnostics(toolId, this.dataPath);
    if (!env) {
      return this.createCompletedItem(definition, 'failed', startedAt, {
        error: 'managed tool environment could not be constructed',
        resolvedPath: expectedPath,
      });
    }

    const invocation = getManagedStartupToolCommandInvocationForDiagnostics(expectedPath, definition.args);
    try {
      const result = await this.commandRunner(invocation.file, invocation.args, {
        cwd: this.dataPath,
        env,
        timeout: VERSION_CHECK_TIMEOUT_MS,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      const versionOutput = normalizeCommandOutput(result.stdout, result.stderr);
      if (!versionOutput) {
        return this.createCompletedItem(definition, 'broken', startedAt, {
          error: 'version command returned no output',
          resolvedPath: expectedPath,
        });
      }
      return this.createCompletedItem(definition, 'ready', startedAt, {
        resolvedPath: expectedPath,
        versionOutput,
      });
    } catch (error) {
      return this.createCompletedItem(definition, 'broken', startedAt, {
        error: sanitizeRuntimeText(error),
        resolvedPath: expectedPath,
      });
    }
  }

  private async probeOne(definition: RuntimeDiagnosticDefinition): Promise<RuntimeDiagnosticItem> {
    const existing = this.probePromises.get(definition.id);
    if (existing) {
      return existing;
    }

    const probePromise = this.runProbe(definition);
    this.probePromises.set(definition.id, probePromise);
    try {
      return await probePromise;
    } finally {
      if (this.probePromises.get(definition.id) === probePromise) {
        this.probePromises.delete(definition.id);
      }
    }
  }

  private async probePython(
    definition: RuntimeDiagnosticDefinition,
    startedAt: number
  ): Promise<RuntimeDiagnosticItem> {
    const expectedPath = definition.resolveExpectedPath(this.dataPath);
    if (!expectedPath) {
      return this.createCompletedItem(definition, 'failed', startedAt, {
        error: 'managed Python command path could not be resolved',
      });
    }

    try {
      if (!(await pathExists(getUvExecutablePathForDiagnostics(this.dataPath)))) {
        return this.createCompletedItem(definition, 'missing', startedAt, {
          error: 'managed uv command is missing',
        });
      }
    } catch (error) {
      return this.createCompletedItem(definition, 'unsupported', startedAt, {
        error: sanitizeRuntimeText(error),
      });
    }

    const env = { ...process.env };
    try {
      addManagedUvBinsToPath(this.dataPath, env);
      const installDirectory = getManagedPythonInstallDirectoryForDiagnostics(this.dataPath);
      const installDirectoryExists = await pathExists(installDirectory);
      const discovered = await findManagedPythonForDiagnostics(this.dataPath, env, this.commandRunner);
      if (!isManagedPythonCommandDirectorySafeForDiagnostics(this.dataPath)) {
        return this.createCompletedItem(definition, 'broken', startedAt, {
          error: 'managed Python command directory is not application-owned',
          resolvedPath: discovered.executablePath,
          versionOutput: discovered.versionOutput,
        });
      }
      if (!(await pathExists(expectedPath))) {
        return this.createCompletedItem(definition, installDirectoryExists ? 'broken' : 'missing', startedAt, {
          error: 'managed python command link is missing',
          resolvedPath: discovered.executablePath,
          versionOutput: discovered.versionOutput,
        });
      }

      const commandResult = await this.commandRunner(expectedPath, definition.args, {
        cwd: this.dataPath,
        env,
        timeout: VERSION_CHECK_TIMEOUT_MS,
      });
      const versionOutput = normalizeCommandOutput(commandResult.stdout, commandResult.stderr);
      if (!/^Python 3\.14(?:\.\d+)?(?:[a-z0-9._-]*)?(?:\s|$)/im.test(versionOutput)) {
        return this.createCompletedItem(definition, 'broken', startedAt, {
          error: 'managed python command did not report Python 3.14',
          resolvedPath: discovered.executablePath,
          versionOutput: versionOutput || discovered.versionOutput,
        });
      }
      return this.createCompletedItem(definition, 'ready', startedAt, {
        resolvedPath: discovered.executablePath,
        versionOutput,
      });
    } catch (error) {
      const installDirectoryExists = await pathExists(getManagedPythonInstallDirectoryForDiagnostics(this.dataPath));
      return this.createCompletedItem(definition, installDirectoryExists ? 'broken' : 'missing', startedAt, {
        error: sanitizeRuntimeText(error),
      });
    }
  }

  private async probeUv(definition: RuntimeDiagnosticDefinition, startedAt: number): Promise<RuntimeDiagnosticItem> {
    let expectedPath: string;
    let uvxPath: string;
    try {
      expectedPath = getUvExecutablePathForDiagnostics(this.dataPath);
      uvxPath = getUvExecutablePathForDiagnostics(this.dataPath, 'uvx');
    } catch (error) {
      return this.createCompletedItem(definition, 'unsupported', startedAt, {
        error: sanitizeRuntimeText(error),
      });
    }

    if (!(await pathExists(expectedPath)) || !(await pathExists(uvxPath))) {
      return this.createCompletedItem(definition, 'missing', startedAt, {
        error: 'managed uv or uvx command is missing',
      });
    }

    const env = { ...process.env };
    addManagedUvBinsToPath(this.dataPath, env);
    try {
      const result = await this.commandRunner(expectedPath, definition.args, {
        cwd: this.dataPath,
        env,
        timeout: VERSION_CHECK_TIMEOUT_MS,
      });
      const versionOutput = normalizeCommandOutput(result.stdout, result.stderr);
      if (!versionOutput) {
        return this.createCompletedItem(definition, 'broken', startedAt, {
          error: 'version command returned no output',
          resolvedPath: expectedPath,
        });
      }
      if (!/\buv\s+0\.11\.31(?:\s|$)/i.test(versionOutput)) {
        return this.createCompletedItem(definition, 'broken', startedAt, {
          error: 'managed uv version does not match the required version',
          resolvedPath: expectedPath,
          versionOutput,
        });
      }
      return this.createCompletedItem(definition, 'ready', startedAt, {
        resolvedPath: expectedPath,
        versionOutput,
      });
    } catch (error) {
      return this.createCompletedItem(definition, 'broken', startedAt, {
        error: sanitizeRuntimeText(error),
        resolvedPath: expectedPath,
      });
    }
  }

  private resolveDefinitions(ids?: string[]): RuntimeDiagnosticDefinition[] {
    if (!ids?.length) {
      return [...this.definitions];
    }
    const requested = new Set(ids);
    return this.definitions.filter((definition) => requested.has(definition.id));
  }

  private async runInstall(definition: RuntimeDiagnosticDefinition): Promise<RuntimeDiagnosticItem> {
    const startedAt = this.now();
    this.createProgressItem(definition, 'installing');

    try {
      const result = await this.runInstaller(definition);
      if (result.status === 'skipped') {
        return this.createCompletedItem(definition, 'skipped', startedAt, {
          error: result.error,
          lastInstalledAt: this.now(),
        });
      }
      if (result.status !== 'ready') {
        return this.createCompletedItem(definition, 'failed', startedAt, {
          error: result.error ?? 'installation failed',
          lastInstalledAt: this.now(),
        });
      }
      const item = await this.probeOne(definition);
      return this.publish({
        ...item,
        lastInstalledAt: this.now(),
      });
    } catch (error) {
      return this.createCompletedItem(definition, 'failed', startedAt, {
        error: sanitizeRuntimeText(error),
        lastInstalledAt: this.now(),
      });
    }
  }

  private async runInstaller(
    definition: RuntimeDiagnosticDefinition
  ): Promise<UvBootstrapResult | ManagedPythonBootstrapResult | OpenCodeBootstrapResult> {
    if (definition.kind === 'uv') {
      return this.ensureUvRuntime({
        commandRunner: this.commandRunner,
        dataPath: this.dataPath,
      });
    }
    if (definition.kind === 'python') {
      return this.ensureManagedPythonRuntime({
        commandRunner: this.commandRunner,
        dataPath: this.dataPath,
        emitStatus: this.emitRuntimeStatus,
      });
    }
    if (!definition.toolId) {
      return { status: 'failed', error: 'managed tool id is missing' };
    }
    return this.ensureManagedToolReady(definition.toolId, {
      commandRunner: this.commandRunner,
      dataPath: this.dataPath,
      emitStatus: this.emitRuntimeStatus,
    });
  }

  private async runProbe(definition: RuntimeDiagnosticDefinition): Promise<RuntimeDiagnosticItem> {
    const startedAt = this.now();
    this.createProgressItem(definition, 'checking');

    if (definition.kind === 'uv') {
      return this.probeUv(definition, startedAt);
    }
    if (definition.kind === 'python') {
      return this.probePython(definition, startedAt);
    }

    let expectedPath: string | null;
    try {
      expectedPath = definition.resolveExpectedPath(this.dataPath);
    } catch (error) {
      return this.createCompletedItem(definition, 'unsupported', startedAt, {
        error: sanitizeRuntimeText(error),
      });
    }
    if (!expectedPath) {
      return this.createCompletedItem(definition, 'failed', startedAt, {
        error: 'managed command path could not be resolved',
      });
    }
    return this.probeManagedNodeTool(definition, expectedPath, startedAt);
  }
}

export function createRuntimeDiagnosticsService(options: RuntimeDiagnosticsServiceOptions): RuntimeDiagnosticsService {
  return new RuntimeDiagnosticsService(options);
}
