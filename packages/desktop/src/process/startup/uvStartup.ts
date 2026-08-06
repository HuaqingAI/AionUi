/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import { ipcBridge } from '@/common';
import type { IRuntimeStatusEvent, IRuntimeStatusScope } from '@/common/adapter/ipcBridge';
import { getDataPath } from '../utils/utils';

export type UvBootstrapStatus = 'ready' | 'skipped' | 'failed';

export type UvBootstrapResult = {
  status: UvBootstrapStatus;
  error?: string;
};

type CommandRunner = (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }
) => Promise<{ stderr?: string; stdout?: string }>;
type CopyArtifact = (source: string, destination: string) => Promise<void>;
type ExtractArtifact = (archivePath: string, destination: string) => Promise<void>;
type RuntimeStatusEmitter = (event: IRuntimeStatusEvent) => void;

type UvStartupEnv = {
  AIONUI_E2E_TEST?: string;
  AIONUI_ZINIAO_BOOTSTRAP?: string;
};

export type EnsureZiniaoReadyOptions = {
  bundledArtifactPath?: string;
  commandRunner?: CommandRunner;
  copyArtifact?: CopyArtifact;
  dataPath?: string;
  emitStatus?: RuntimeStatusEmitter;
  env?: UvStartupEnv;
  extractArtifact?: ExtractArtifact;
};

const UV_VERSION = '0.11.31';
const ZINIAO_PACKAGE_NAME = 'ziniao';
const ZINIAO_MCP_REQUIREMENT = 'mcp<2';
const ZINIAO_PYPI_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const UV_INSTALL_TIMEOUT_MS = 180000;
const NODRIVER_GB18030_ENCODING_HEADER = Buffer.from('# -*- coding: gb18030 -*-\n', 'ascii');
const ZINIAO_STARTUP_SCOPE: IRuntimeStatusScope = {
  kind: 'mcp',
  id: 'startup-ziniao',
};
const execFileAsync = promisify(execFile);

let startupPromise: Promise<UvBootstrapResult> | null = null;

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

function getUvExecutablePath(dataPath = getDataPath(), command: 'uv' | 'uvx' = 'uv'): string {
  return path.join(getUvRuntimeDirectory(dataPath), `${command}${getUvTarget().executableExtension}`);
}

function getZiniaoCommandPath(dataPath = getDataPath()): string {
  return path.join(getUvToolBinDirectory(dataPath), `ziniao${getUvTarget().executableExtension}`);
}

function getZiniaoInstallProfilePath(dataPath = getDataPath()): string {
  return path.join(dataPath, 'runtime', 'uv-tools', 'ziniao', '.aionui-install-profile');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasCurrentZiniaoInstallProfile(dataPath: string): Promise<boolean> {
  try {
    return (await fs.readFile(getZiniaoInstallProfilePath(dataPath), 'utf8')).trim() === ZINIAO_MCP_REQUIREMENT;
  } catch {
    return false;
  }
}

async function patchZiniaoNodriverSource(dataPath: string): Promise<void> {
  const toolDirectory = path.join(dataPath, 'runtime', 'uv-tools', ZINIAO_PACKAGE_NAME);
  let sitePackagesDirectory = path.join(toolDirectory, 'Lib', 'site-packages');

  if (process.platform !== 'win32') {
    try {
      const libraryDirectories = await fs.readdir(path.join(toolDirectory, 'lib'), { withFileTypes: true });
      const pythonDirectory = libraryDirectories.find(
        (directory) => directory.isDirectory() && directory.name.startsWith('python')
      );
      if (!pythonDirectory) {
        return;
      }
      sitePackagesDirectory = path.join(toolDirectory, 'lib', pythonDirectory.name, 'site-packages');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  const networkModulePath = path.join(sitePackagesDirectory, 'nodriver', 'cdp', 'network.py');
  let source: Buffer;
  try {
    source = await fs.readFile(networkModulePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    // nodriver 0.48.x ships this generated CDP file in GB18030 without a declaration.
    if (!source.subarray(0, NODRIVER_GB18030_ENCODING_HEADER.length).equals(NODRIVER_GB18030_ENCODING_HEADER)) {
      await fs.writeFile(networkModulePath, Buffer.concat([NODRIVER_GB18030_ENCODING_HEADER, source]));
    }
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

export function addManagedUvBinsToPath(dataPath = getDataPath(), env: NodeJS.ProcessEnv = process.env): void {
  const toolBin = getUvToolBinDirectory(dataPath);
  const uvBin = getUvRuntimeDirectory(dataPath);
  prependPathEntry(uvBin, env);
  prependPathEntry(toolBin, env);
  env.UV_CACHE_DIR = path.join(dataPath, 'runtime', 'uv-cache');
  env.UV_TOOL_DIR = path.join(dataPath, 'runtime', 'uv-tools');
  env.UV_TOOL_BIN_DIR = toolBin;
  env.UV_PYTHON_INSTALL_DIR = path.join(dataPath, 'runtime', 'uv-python');
  env.UV_MANAGED_PYTHON = '1';
  env.UV_DEFAULT_INDEX = ZINIAO_PYPI_INDEX;
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

function shouldEnsureZiniaoOnStartup(env: UvStartupEnv = process.env): boolean {
  return env.AIONUI_E2E_TEST !== '1' && env.AIONUI_ZINIAO_BOOTSTRAP !== '0';
}

export function isZiniaoBootstrapEnabled(env: UvStartupEnv = process.env): boolean {
  return shouldEnsureZiniaoOnStartup(env);
}

function emitStatus(emitter: RuntimeStatusEmitter, phase: IRuntimeStatusEvent['phase'], message?: string): void {
  emitter({
    resource: 'acp_tool',
    resource_id: 'ziniao',
    scope: ZINIAO_STARTUP_SCOPE,
    phase,
    message,
  });
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

export async function ensureZiniaoReady(options: EnsureZiniaoReadyOptions = {}): Promise<UvBootstrapResult> {
  const env = options.env ?? process.env;
  if (!shouldEnsureZiniaoOnStartup(env)) {
    return { status: 'skipped' };
  }

  const dataPath = options.dataPath ?? getDataPath();
  const statusEmitter = options.emitStatus ?? ipcBridge.runtime.localStatusChanged.emit;
  const commandRunner = options.commandRunner ?? runCommand;
  const copyArtifact = options.copyArtifact ?? fs.copyFile;
  const extractArtifact = options.extractArtifact ?? extractBundledArtifact;

  try {
    addManagedUvBinsToPath(dataPath);
    const ziniaoPath = getZiniaoCommandPath(dataPath);
    const hadZiniao = await pathExists(ziniaoPath);
    const hasCurrentProfile = hadZiniao && (await hasCurrentZiniaoInstallProfile(dataPath));
    const needsZiniaoInstall = !hasCurrentProfile;
    emitStatus(
      statusEmitter,
      needsZiniaoInstall ? 'extracting' : 'validating',
      needsZiniaoInstall ? 'Preparing bundled uv and Ziniao MCP' : 'Checking Ziniao MCP installation'
    );
    await ensureUvInstalled({
      bundledArtifactPath: options.bundledArtifactPath,
      copyArtifact,
      dataPath,
      extractArtifact,
    });
    if (needsZiniaoInstall) {
      await fs.mkdir(getUvToolBinDirectory(dataPath), { recursive: true });
      await commandRunner(
        getUvExecutablePath(dataPath),
        [
          'tool',
          'install',
          '--reinstall',
          '--default-index',
          ZINIAO_PYPI_INDEX,
          '--with',
          ZINIAO_MCP_REQUIREMENT,
          ZINIAO_PACKAGE_NAME,
        ],
        {
          cwd: dataPath,
          env: process.env,
          timeout: UV_INSTALL_TIMEOUT_MS,
        }
      );
    }
    await patchZiniaoNodriverSource(dataPath);
    if (!(await pathExists(ziniaoPath))) {
      throw new Error('ziniao command was not created after installation');
    }
    if (needsZiniaoInstall) {
      const installProfilePath = getZiniaoInstallProfilePath(dataPath);
      await fs.mkdir(path.dirname(installProfilePath), { recursive: true });
      await fs.writeFile(installProfilePath, `${ZINIAO_MCP_REQUIREMENT}\n`, 'utf8');
    }
    emitStatus(statusEmitter, 'ready', 'Ziniao MCP is ready');
    return { status: 'ready' };
  } catch (error) {
    const message = normalizeError(error);
    emitStatus(statusEmitter, 'failed', message);
    return { status: 'failed', error: message };
  }
}

export function ensureZiniaoReadyOnce(options: EnsureZiniaoReadyOptions = {}): Promise<UvBootstrapResult> {
  if (!startupPromise) {
    startupPromise = ensureZiniaoReady(options);
  }
  return startupPromise;
}

export async function ensureZiniaoReadyOnStartup(options: EnsureZiniaoReadyOptions = {}): Promise<UvBootstrapResult> {
  const result = await ensureZiniaoReadyOnce(options);
  if (result.status === 'ready') {
    console.info('[Ziniao] managed uv and MCP command are ready');
  } else if (result.status === 'skipped') {
    console.info('[Ziniao] startup bootstrap skipped');
  } else {
    console.warn('[Ziniao] managed uv bootstrap failed:', result.error);
  }
  return result;
}
