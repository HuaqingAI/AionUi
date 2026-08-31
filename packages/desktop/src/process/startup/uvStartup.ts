/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { constants as fsConstants, lstatSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import type { IRuntimeStatusEvent } from '@/common/adapter/ipcBridge';
import { getDataPath } from '../utils/utils';

export type UvBootstrapStatus = 'ready' | 'skipped' | 'failed';
export type ManagedPythonBootstrapStatus = UvBootstrapStatus;

export type UvBootstrapResult = {
  status: UvBootstrapStatus;
  error?: string;
};

export type ManagedPythonBootstrapResult = {
  status: ManagedPythonBootstrapStatus;
  error?: string;
};

type CopyArtifact = (source: string, destination: string) => Promise<void>;
type ExtractArtifact = (archivePath: string, destination: string) => Promise<void>;
type UvStartupEnv = {
  AIONUI_E2E_TEST?: string;
};

export type ManagedPythonCommandRunner = (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }
) => Promise<{ stderr?: string; stdout?: string }>;

export type EnsureUvReadyOptions = {
  bundledArtifactPath?: string;
  copyArtifact?: CopyArtifact;
  dataPath?: string;
  env?: UvStartupEnv;
  extractArtifact?: ExtractArtifact;
};

export type EnsureManagedPythonOptions = {
  commandRunner?: ManagedPythonCommandRunner;
  dataPath?: string;
  emitStatus?: (event: IRuntimeStatusEvent) => void;
  env?: UvStartupEnv & NodeJS.ProcessEnv;
};

const UV_VERSION = '0.11.31';
const UV_INSTALL_TIMEOUT_MS = 180000;
const MANAGED_PYTHON_VERSION = '3.14';
const MANAGED_PYTHON_SCOPE = {
  kind: 'custom_agent' as const,
  id: 'startup-python',
};
const MANAGED_PYTHON_RESOURCE_ID = 'python-3.14';
const execFileAsync = promisify(execFile);

let startupPromise: Promise<UvBootstrapResult> | null = null;
let managedPythonPromise: Promise<ManagedPythonBootstrapResult> | null = null;
let latestManagedPythonStatus: IRuntimeStatusEvent | null = null;

class ManagedPythonFindCommandError extends Error {
  constructor(cause: unknown) {
    super(normalizeError(cause));
    this.name = 'ManagedPythonFindCommandError';
  }
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getUvTarget(): {
  archiveName: string;
  archiveRoot: string;
  executableExtension: string;
  versionDirectory: string;
} {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32' && arch === 'x64') {
    return {
      archiveName: 'uv-x86_64-pc-windows-msvc.zip',
      archiveRoot: '',
      executableExtension: '.exe',
      versionDirectory: `uv-v${UV_VERSION}-win32-x64`,
    };
  }
  if (platform === 'darwin' && arch === 'x64') {
    return {
      archiveName: 'uv-x86_64-apple-darwin.tar.gz',
      archiveRoot: 'uv-x86_64-apple-darwin',
      executableExtension: '',
      versionDirectory: `uv-v${UV_VERSION}-darwin-x64`,
    };
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      archiveName: 'uv-aarch64-apple-darwin.tar.gz',
      archiveRoot: 'uv-aarch64-apple-darwin',
      executableExtension: '',
      versionDirectory: `uv-v${UV_VERSION}-darwin-arm64`,
    };
  }
  throw new Error(`managed uv is not supported on ${platform}-${arch}`);
}

export function getBundledUvArtifactName(): string {
  return getUvTarget().archiveName;
}

function getRuntimeKey(): string {
  return `${process.platform}-${process.arch}`;
}

function getUvRuntimeRoot(dataPath = getDataPath()): string {
  return path.join(dataPath, 'runtime', 'uv');
}

function getUvRuntimeDirectory(dataPath = getDataPath()): string {
  return path.join(getUvRuntimeRoot(dataPath), getUvTarget().versionDirectory);
}

function getUvToolBinDirectory(dataPath = getDataPath()): string {
  return path.join(dataPath, 'runtime', 'uv-tool-bin');
}

function getManagedPythonInstallDirectory(dataPath = getDataPath()): string {
  return path.join(dataPath, 'runtime', 'uv-python');
}

export function getManagedPythonCommandDirectory(dataPath = getDataPath()): string {
  return path.join(dataPath, 'runtime', 'uv-python-bin');
}

function getUvExecutablePath(dataPath = getDataPath(), command: 'uv' | 'uvx' = 'uv'): string {
  return path.join(getUvRuntimeDirectory(dataPath), `${command}${getUvTarget().executableExtension}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function prependPathEntry(entry: string, env: NodeJS.ProcessEnv): void {
  const currentPath = env.PATH ?? env.Path ?? '';
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  const hasEntry = entries.some((item) => path.resolve(item).toLowerCase() === path.resolve(entry).toLowerCase());
  if (hasEntry) {
    return;
  }

  const updatedPath = [entry, ...entries].join(path.delimiter);
  env.PATH = updatedPath;
  if (process.platform === 'win32') {
    env.Path = updatedPath;
  }
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isManagedPythonCommandDirectorySafe(dataPath: string): boolean {
  const commandDirectory = getManagedPythonCommandDirectory(dataPath);
  const managedInstallDirectory = path.resolve(getManagedPythonInstallDirectory(dataPath));

  try {
    const commandDirectoryStats = lstatSync(commandDirectory);
    if (process.platform === 'win32') {
      return (
        commandDirectoryStats.isSymbolicLink() &&
        isPathInside(managedInstallDirectory, realpathSync(commandDirectory))
      );
    }
    if (!commandDirectoryStats.isDirectory() || commandDirectoryStats.isSymbolicLink()) {
      return false;
    }

    const commandPath = path.join(commandDirectory, 'python');
    return lstatSync(commandPath).isSymbolicLink() && isPathInside(managedInstallDirectory, realpathSync(commandPath));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export function addManagedUvBinsToPath(dataPath = getDataPath(), env: NodeJS.ProcessEnv = process.env): void {
  const toolBin = getUvToolBinDirectory(dataPath);
  const uvBin = getUvRuntimeDirectory(dataPath);
  const pythonBin = getManagedPythonCommandDirectory(dataPath);
  prependPathEntry(uvBin, env);
  prependPathEntry(toolBin, env);
  if (isManagedPythonCommandDirectorySafe(dataPath)) {
    prependPathEntry(pythonBin, env);
  }
  env.UV_CACHE_DIR = path.join(dataPath, 'runtime', 'uv-cache');
  env.UV_TOOL_DIR = path.join(dataPath, 'runtime', 'uv-tools');
  env.UV_TOOL_BIN_DIR = toolBin;
  env.UV_PYTHON_INSTALL_DIR = getManagedPythonInstallDirectory(dataPath);
  env.UV_MANAGED_PYTHON = '1';
  env.UV_NO_PROGRESS = '1';
}

async function runCommand(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }
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

async function validateManagedPythonExecutable(
  dataPath: string,
  candidatePath: string,
  env: NodeJS.ProcessEnv,
  commandRunner: ManagedPythonCommandRunner
): Promise<string> {
  const trimmedPath = candidatePath.trim();
  if (!trimmedPath || !path.isAbsolute(trimmedPath)) {
    throw new Error('uv did not report an absolute managed Python executable path');
  }

  const managedInstallDirectory = path.resolve(getManagedPythonInstallDirectory(dataPath));
  const declaredExecutablePath = path.resolve(trimmedPath);
  if (!isPathInside(managedInstallDirectory, declaredExecutablePath)) {
    throw new Error('uv reported a Python executable outside the managed runtime directory');
  }

  const installStats = await fs.lstat(managedInstallDirectory);
  if (installStats.isSymbolicLink()) {
    throw new Error('managed Python installation directory must not be a symlink');
  }

  const installDirectory = await fs.realpath(managedInstallDirectory);
  const executablePath = await fs.realpath(trimmedPath);
  if (!isPathInside(installDirectory, executablePath)) {
    throw new Error('uv reported a Python executable outside the managed runtime directory');
  }

  const executableStats = await fs.stat(executablePath);
  if (!executableStats.isFile()) {
    throw new Error('uv reported a managed Python path that is not a file');
  }

  const executableName = path.basename(executablePath).toLowerCase();
  const expectedName =
    process.platform === 'win32' ? executableName === 'python.exe' : /^python(?:\d+(?:\.\d+)*)?$/.test(executableName);
  if (!expectedName) {
    throw new Error('uv reported a managed runtime file that is not a Python executable');
  }

  if (process.platform !== 'win32') {
    await fs.access(executablePath, fsConstants.X_OK);
  }

  const versionResult = await commandRunner(executablePath, ['--version'], {
    cwd: dataPath,
    env,
    timeout: UV_INSTALL_TIMEOUT_MS,
  });
  const versionOutput = `${versionResult.stdout ?? ''}\n${versionResult.stderr ?? ''}`.trim();
  if (!/^Python 3\.14(?:\.\d+)?(?:[a-z0-9._-]*)?(?:\s|$)/im.test(versionOutput)) {
    throw new Error('uv reported a managed runtime file that is not Python 3.14');
  }

  return executablePath;
}

async function refreshManagedPythonCommandDirectory(dataPath: string, executablePath: string): Promise<void> {
  const commandDirectory = getManagedPythonCommandDirectory(dataPath);

  if (process.platform === 'win32') {
    const executableDirectory = path.dirname(executablePath);
    let existingStats: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try {
      existingStats = await fs.lstat(commandDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    if (existingStats) {
      if (!existingStats.isSymbolicLink()) {
        throw new Error('managed Python command directory is not an application-owned junction');
      }
      try {
        const existingTarget = await fs.realpath(commandDirectory);
        if (path.resolve(existingTarget).toLowerCase() === path.resolve(executableDirectory).toLowerCase()) {
          return;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      await fs.rm(commandDirectory, { force: false, recursive: true });
    }

    await fs.symlink(executableDirectory, commandDirectory, 'junction');
    return;
  }

  await fs.mkdir(commandDirectory, { recursive: true });
  const commandPath = path.join(commandDirectory, 'python');
  try {
    const existingStats = await fs.lstat(commandPath);
    if (!existingStats.isSymbolicLink()) {
      throw new Error('managed Python command is not an application-owned symlink');
    }
    await fs.unlink(commandPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await fs.symlink(executablePath, commandPath);
}

function emitManagedPythonStatus(
  emitStatus: EnsureManagedPythonOptions['emitStatus'],
  phase: IRuntimeStatusEvent['phase'],
  failureKind?: IRuntimeStatusEvent['failure_kind'],
  message?: string
): void {
  const event: IRuntimeStatusEvent = {
    resource: 'python',
    resource_id: MANAGED_PYTHON_RESOURCE_ID,
    scope: MANAGED_PYTHON_SCOPE,
    phase,
    ...(failureKind ? { failure_kind: failureKind } : {}),
    ...(message ? { message } : {}),
  };
  latestManagedPythonStatus = event;
  emitStatus?.(event);
}

export function getLatestManagedPythonStatus(): IRuntimeStatusEvent | null {
  return latestManagedPythonStatus;
}

async function findManagedPython(
  dataPath: string,
  env: NodeJS.ProcessEnv,
  commandRunner: ManagedPythonCommandRunner
): Promise<string> {
  let result: { stderr?: string; stdout?: string };
  try {
    result = await commandRunner(getUvExecutablePath(dataPath), ['python', 'find', MANAGED_PYTHON_VERSION], {
      cwd: dataPath,
      env,
      timeout: UV_INSTALL_TIMEOUT_MS,
    });
  } catch (error) {
    throw new ManagedPythonFindCommandError(error);
  }
  return validateManagedPythonExecutable(dataPath, result.stdout ?? '', env, commandRunner);
}

async function extractWindowsZip(archivePath: string, destination: string): Promise<void> {
  const expectedFiles = new Set(['uv.exe', 'uvx.exe']);
  const extractedFiles = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        reject(openError ?? new Error('unable to open bundled uv archive'));
        return;
      }

      const fail = (error: unknown): void => {
        zipfile.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        const name = entry.fileName.replace(/\\/g, '/');
        if (!expectedFiles.has(name)) {
          zipfile.readEntry();
          return;
        }
        if (extractedFiles.has(name)) {
          fail(new Error(`bundled uv archive contains duplicate ${name}`));
          return;
        }

        zipfile.openReadStream(entry, (streamError, readStream) => {
          if (streamError || !readStream) {
            fail(streamError ?? new Error(`unable to extract ${name}`));
            return;
          }
          const chunks: Buffer[] = [];
          readStream.on('data', (chunk: Buffer) => chunks.push(chunk));
          readStream.on('error', fail);
          readStream.on('end', () => {
            fs.writeFile(path.join(destination, name), Buffer.concat(chunks))
              .then(() => {
                extractedFiles.add(name);
                zipfile.readEntry();
              })
              .catch(fail);
          });
        });
      });
      zipfile.on('error', fail);
      zipfile.on('end', () => resolve());
    });
  });

  if (extractedFiles.size !== expectedFiles.size) {
    throw new Error('bundled uv archive did not contain both uv.exe and uvx.exe');
  }
}

async function extractBundledArtifact(archivePath: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  if (process.platform === 'win32') {
    await extractWindowsZip(archivePath, destination);
    return;
  }
  if (process.platform === 'darwin') {
    const { archiveRoot } = getUvTarget();
    await runCommand(
      'tar',
      ['-xzf', archivePath, '-C', destination, '--strip-components=1', `${archiveRoot}/uv`, `${archiveRoot}/uvx`],
      { timeout: UV_INSTALL_TIMEOUT_MS }
    );
    await Promise.all([fs.chmod(path.join(destination, 'uv'), 0o755), fs.chmod(path.join(destination, 'uvx'), 0o755)]);
    return;
  }
  throw new Error(`managed uv is not supported on ${process.platform}-${process.arch}`);
}

async function findBundledUvArtifact(): Promise<string> {
  const archiveName = getBundledUvArtifactName();
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath &&
      path.join(resourcesPath, 'bundled-aioncore', getRuntimeKey(), 'managed-resources', 'uv', archiveName),
    path.resolve(process.cwd(), 'resources', 'uv-artifacts', archiveName),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const candidateChecks = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      exists: await pathExists(candidate),
    }))
  );
  const bundledArtifact = candidateChecks.find((candidate) => candidate.exists)?.candidate;
  if (bundledArtifact) {
    return bundledArtifact;
  }
  throw new Error(`bundled uv artifact is missing: ${archiveName}`);
}

function shouldEnsureUvOnStartup(env: UvStartupEnv = process.env): boolean {
  return env.AIONUI_E2E_TEST !== '1';
}

export function isUvBootstrapEnabled(env: UvStartupEnv = process.env): boolean {
  return shouldEnsureUvOnStartup(env);
}

export async function ensureManagedPython(
  options: EnsureManagedPythonOptions = {}
): Promise<ManagedPythonBootstrapResult> {
  const env = options.env ?? process.env;
  if (!shouldEnsureUvOnStartup(env)) {
    return { status: 'skipped' };
  }

  const dataPath = options.dataPath ?? getDataPath();
  const commandRunner = options.commandRunner ?? runCommand;

  try {
    const uvResult = await ensureUvReady({ dataPath, env });
    if (uvResult.status !== 'ready') {
      const message = uvResult.error ?? 'managed uv runtime is not ready';
      emitManagedPythonStatus(options.emitStatus, 'failed', 'validation_failed', message);
      return { status: 'failed', error: message };
    }

    emitManagedPythonStatus(options.emitStatus, 'validating');
    let executablePath: string;
    try {
      executablePath = await findManagedPython(dataPath, env, commandRunner);
    } catch (findError) {
      if (!(findError instanceof ManagedPythonFindCommandError)) {
        throw findError;
      }

      emitManagedPythonStatus(options.emitStatus, 'downloading');
      try {
        await commandRunner(getUvExecutablePath(dataPath), ['python', 'install', MANAGED_PYTHON_VERSION], {
          cwd: dataPath,
          env,
          timeout: UV_INSTALL_TIMEOUT_MS,
        });
      } catch (installError) {
        const message = normalizeError(installError);
        emitManagedPythonStatus(options.emitStatus, 'failed', 'download_failed', message);
        return { status: 'failed', error: message };
      }

      emitManagedPythonStatus(options.emitStatus, 'validating');
      try {
        executablePath = await findManagedPython(dataPath, env, commandRunner);
      } catch (validationError) {
        const message = normalizeError(validationError);
        emitManagedPythonStatus(options.emitStatus, 'failed', 'validation_failed', message);
        return { status: 'failed', error: message };
      }
    }

    await refreshManagedPythonCommandDirectory(dataPath, executablePath);
    prependPathEntry(getManagedPythonCommandDirectory(dataPath), env);
    prependPathEntry(path.dirname(executablePath), env);
    emitManagedPythonStatus(options.emitStatus, 'ready');
    return { status: 'ready' };
  } catch (error) {
    const message = normalizeError(error);
    emitManagedPythonStatus(options.emitStatus, 'failed', 'validation_failed', message);
    return { status: 'failed', error: message };
  }
}

export function ensureManagedPythonOnce(
  options: EnsureManagedPythonOptions = {}
): Promise<ManagedPythonBootstrapResult> {
  if (managedPythonPromise) {
    return managedPythonPromise;
  }

  const bootstrapPromise = ensureManagedPython(options);
  managedPythonPromise = bootstrapPromise;
  void bootstrapPromise.finally(() => {
    if (managedPythonPromise === bootstrapPromise) {
      managedPythonPromise = null;
    }
  });
  return bootstrapPromise;
}

export async function ensureManagedPythonOnStartup(
  options: EnsureManagedPythonOptions = {}
): Promise<ManagedPythonBootstrapResult> {
  const result = await ensureManagedPythonOnce(options);
  if (result.status === 'ready') {
    console.info('[uv] managed Python 3.14 runtime is ready');
  } else if (result.status === 'failed') {
    console.warn('[uv] managed Python 3.14 runtime bootstrap failed:', result.error);
  }
  return result;
}

async function ensureUvInstalled(options: {
  bundledArtifactPath?: string;
  copyArtifact: CopyArtifact;
  dataPath: string;
  extractArtifact: ExtractArtifact;
}): Promise<void> {
  const uvPath = getUvExecutablePath(options.dataPath);
  const uvxPath = getUvExecutablePath(options.dataPath, 'uvx');
  if ((await pathExists(uvPath)) && (await pathExists(uvxPath))) {
    return;
  }

  const runtimeRoot = getUvRuntimeRoot(options.dataPath);
  const runtimeDirectory = getUvRuntimeDirectory(options.dataPath);
  const target = getUvTarget();
  const stagingDirectory = path.join(runtimeRoot, `.${target.versionDirectory}-${process.pid}-${Date.now()}`);
  const archivePath = path.join(
    runtimeRoot,
    `${target.versionDirectory}-${process.pid}-${Date.now()}.${target.archiveName}`
  );
  const bundledArtifactPath = options.bundledArtifactPath ?? (await findBundledUvArtifact());

  await fs.mkdir(runtimeRoot, { recursive: true });
  try {
    await options.copyArtifact(bundledArtifactPath, archivePath);
    await options.extractArtifact(archivePath, stagingDirectory);
    if (!(await pathExists(path.join(stagingDirectory, `uv${target.executableExtension}`)))) {
      throw new Error('uv executable was not found after extraction');
    }
    if (!(await pathExists(path.join(stagingDirectory, `uvx${target.executableExtension}`)))) {
      throw new Error('uvx executable was not found after extraction');
    }
    await fs.rename(stagingDirectory, runtimeDirectory);
  } finally {
    await Promise.all([fs.rm(archivePath, { force: true }), fs.rm(stagingDirectory, { force: true, recursive: true })]);
  }
}

export async function ensureUvReady(options: EnsureUvReadyOptions = {}): Promise<UvBootstrapResult> {
  const env = options.env ?? process.env;
  if (!shouldEnsureUvOnStartup(env)) {
    return { status: 'skipped' };
  }

  const dataPath = options.dataPath ?? getDataPath();
  const copyArtifact = options.copyArtifact ?? fs.copyFile;
  const extractArtifact = options.extractArtifact ?? extractBundledArtifact;

  try {
    addManagedUvBinsToPath(dataPath, env);
    await ensureUvInstalled({
      bundledArtifactPath: options.bundledArtifactPath,
      copyArtifact,
      dataPath,
      extractArtifact,
    });
    return { status: 'ready' };
  } catch (error) {
    const message = normalizeError(error);
    return { status: 'failed', error: message };
  }
}

export function ensureUvReadyOnce(options: EnsureUvReadyOptions = {}): Promise<UvBootstrapResult> {
  if (!startupPromise) {
    startupPromise = ensureUvReady(options);
  }
  return startupPromise;
}

export async function ensureUvReadyOnStartup(options: EnsureUvReadyOptions = {}): Promise<UvBootstrapResult> {
  const result = await ensureUvReadyOnce(options);
  if (result.status === 'ready') {
    console.info('[uv] managed runtime is ready');
  } else if (result.status === 'skipped') {
    console.info('[uv] startup bootstrap skipped');
  } else {
    console.warn('[uv] managed runtime bootstrap failed:', result.error);
  }
  return result;
}
