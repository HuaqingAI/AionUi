import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const { extractArchive } = require('../../../packages/shared-scripts/src/prepare-aioncore');

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== 'win32')('aioncore Windows archive extraction', () => {
  it('extracts nested files when the inherited Archive module is incompatible', () => {
    const root = mkdtempSync(join(tmpdir(), 'aionui-archive-'));
    tempDirs.push(root);
    const sourceDir = join(root, "source with ' quotes");
    mkdirSync(join(sourceDir, 'nested'), { recursive: true });
    writeFileSync(join(sourceDir, 'nested', 'aioncore.exe'), 'aioncore fixture');
    const archivePath = join(root, "archive with ' quotes.zip");
    execFileSync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${sourceDir.replace(/'/g, "''")}', '${archivePath.replace(/'/g, "''")}')`,
    ]);

    const moduleRoot = join(root, 'modules');
    const archiveModule = join(moduleRoot, 'Microsoft.PowerShell.Archive');
    mkdirSync(archiveModule, { recursive: true });
    writeFileSync(
      join(archiveModule, 'Microsoft.PowerShell.Archive.psm1'),
      `function Expand-Archive { throw 'Incompatible inherited Archive module' }; Export-ModuleMember -Function Expand-Archive`
    );

    const previousModulePath = process.env.PSModulePath;
    process.env.PSModulePath = [moduleRoot, previousModulePath].filter(Boolean).join(delimiter);
    const outputDir = join(root, "output with ' quotes");
    try {
      expect(() => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive'])).toThrow(
        /Incompatible inherited Archive module/
      );
      extractArchive(archivePath, outputDir, 'win32');
      expect(readFileSync(join(outputDir, 'nested', 'aioncore.exe'), 'utf8')).toBe('aioncore fixture');
    } finally {
      if (previousModulePath === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = previousModulePath;
    }
  });

  it('rejects a corrupt ZIP instead of returning without extracting files', () => {
    const root = mkdtempSync(join(tmpdir(), 'aionui-archive-'));
    tempDirs.push(root);
    const archivePath = join(root, 'corrupt.zip');
    writeFileSync(archivePath, 'not a ZIP archive');

    expect(() => extractArchive(archivePath, join(root, 'output'), 'win32')).toThrow(/ExtractToDirectory/);
  });
});
