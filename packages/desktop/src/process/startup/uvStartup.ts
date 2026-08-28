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
import { getDataPath } from '../utils/utils';

export type UvBootstrapStatus = 'ready' | 'skipped' | 'failed';

export type UvBootstrapResult = {
  status: UvBootstrapStatus;
  error?: string;
};

type CopyArtifact = (source: string, destination: string) => Promise<void>;
type ExtractArtifact = (archivePath: string, destination: string) => Promise<void>;
type UvStartupEnv = {
  AIONUI_E2E_TEST?: string;
};

export type EnsureUvReadyOptions = {
  bundledArtifactPath?: string;
  copyArtifact?: CopyArtifact;
  dataPath?: string;
  env?: UvStartupEnv;
  extractArtifact?: ExtractArtifact;
};

const UV_VERSION = '0.11.31';
const UV_INSTALL_TIMEOUT_MS = 180000;
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

function shouldEnsureUvOnStartup(env: UvStartupEnv = process.env): boolean {
  return env.AIONUI_E2E_TEST !== '1';
}

export function isUvBootstrapEnabled(env: UvStartupEnv = process.env): boolean {
  return shouldEnsureUvOnStartup(env);
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
    addManagedUvBinsToPath(dataPath);
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
