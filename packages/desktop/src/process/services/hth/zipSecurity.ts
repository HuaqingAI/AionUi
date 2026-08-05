/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import path from 'path';
import yauzl from 'yauzl';

export type ZipSection = 'global' | 'project';

export type ZipExtractedEntry = {
  section: ZipSection;
  relativePath: string;
  size: number;
};

export type ExtractZipOptions = {
  maxFiles?: number;
  maxTotalBytes?: number;
};

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const ALLOWED_SECTIONS = new Set<ZipSection>(['global', 'project']);

export function normalizeZipEntryPath(entryName: string): { section: ZipSection; relativePath: string } | null {
  const normalized = entryName.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.endsWith('/')) {
    return null;
  }
  if (/^[a-zA-Z]:/.test(normalized) || normalized.includes('\0')) {
    throw new Error(`Unsafe zip entry path: ${entryName}`);
  }

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 2 || parts.some((part) => part === '..' || part === '.')) {
    throw new Error(`Unsafe zip entry path: ${entryName}`);
  }

  const section = parts[0] as ZipSection;
  if (!ALLOWED_SECTIONS.has(section)) {
    throw new Error(`Unsupported zip entry root: ${parts[0]}`);
  }

  return {
    section,
    relativePath: parts.slice(1).join('/'),
  };
}

export function assertPathInside(baseDir: string, targetPath: string): void {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`Resolved path escapes target directory: ${targetPath}`);
}

export async function copyManagedSection(sourceDir: string, section: ZipSection, targetDir: string): Promise<string[]> {
  const sectionDir = path.join(sourceDir, section);
  try {
    const stat = await fs.stat(sectionDir);
    if (!stat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const copied: string[] = [];
  await copyDirectory(sectionDir, targetDir, '', copied);
  await writeSyncManifest(targetDir, copied);
  return copied;
}

async function copyDirectory(
  sourceDir: string,
  targetDir: string,
  relativeDir: string,
  copied: string[]
): Promise<void> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const nextRelative = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    const targetPath = path.join(targetDir, nextRelative);
    assertPathInside(targetDir, targetPath);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetDir, nextRelative, copied);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
    copied.push(nextRelative.replace(/\\/g, '/'));
  }
}

async function writeSyncManifest(targetDir: string, files: string[]): Promise<void> {
  const manifestPath = path.join(targetDir, '.aionui-hth-sync.json');
  assertPathInside(targetDir, manifestPath);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        managedBy: 'aionui-hth',
        files,
        updatedAt: Date.now(),
      },
      null,
      2
    ),
    'utf8'
  );
}

export async function extractZip(
  zipPath: string,
  targetDir: string,
  options: ExtractZipOptions = {}
): Promise<ZipExtractedEntry[]> {
  await fs.rm(targetDir, { force: true, recursive: true });
  await fs.mkdir(targetDir, { recursive: true });

  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const extracted: ZipExtractedEntry[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        reject(openError ?? new Error('Unable to open zip file'));
        return;
      }

      const fail = (error: unknown): void => {
        zipfile.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        let normalized: { section: ZipSection; relativePath: string } | null;
        try {
          normalized = normalizeZipEntryPath(entry.fileName);
        } catch (error) {
          fail(error);
          return;
        }
        if (!normalized) {
          zipfile.readEntry();
          return;
        }

        fileCount += 1;
        totalBytes += entry.uncompressedSize;
        if (fileCount > maxFiles || totalBytes > maxTotalBytes) {
          fail(new Error('Zip package exceeds allowed size limits'));
          return;
        }

        const outputPath = path.join(targetDir, normalized.section, normalized.relativePath);
        try {
          assertPathInside(targetDir, outputPath);
        } catch (error) {
          fail(error);
          return;
        }

        zipfile.openReadStream(entry, (streamError, readStream) => {
          if (streamError || !readStream) {
            fail(streamError ?? new Error('Unable to read zip entry'));
            return;
          }

          const chunks: Buffer[] = [];
          readStream.on('data', (chunk: Buffer) => chunks.push(chunk));
          readStream.on('error', fail);
          readStream.on('end', () => {
            const data = Buffer.concat(chunks);
            fs.mkdir(path.dirname(outputPath), { recursive: true })
              .then(() => fs.writeFile(outputPath, data))
              .then(() => {
                extracted.push({ ...normalized, size: data.byteLength });
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

  return extracted;
}
