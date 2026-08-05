/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HTHAgentConfigItem, HTHCliType } from '@/common/types/hth';
import { app } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

export type HTHPackageManifest = {
  packageId: string;
  assistantId: string;
  cliType: HTHCliType;
  globalTarget?: 'opencode' | 'codex';
  artifactKey?: string;
  sourceUrl: string;
  sourceUrlExpiresAt?: number;
  version: string;
  sha256?: string;
  size?: number;
  avatarSha256?: string;
  avatarPath?: string;
  name: string;
  syncedAt: number;
  extractDir: string;
  globalFiles: string[];
  projectFiles: string[];
};

const MANIFEST_FILE = 'manifest.json';
const PACKAGE_ID_HASH_LENGTH = 16;
const ASSISTANT_ID_HASH_LENGTH = 16;

function parseVersionSegments(version: string): [number, number, number] {
  const [baseVersion] = version.trim().split(/[+-]/);
  const segments = baseVersion.split('.').map((segment) => {
    const value = Number.parseInt(segment, 10);
    return Number.isFinite(value) ? value : 0;
  });
  return [segments[0] ?? 0, segments[1] ?? 0, segments[2] ?? 0];
}

function compareManifestsByFreshness(a: HTHPackageManifest, b: HTHPackageManifest): number {
  const aVersion = parseVersionSegments(a.version);
  const bVersion = parseVersionSegments(b.version);
  for (let index = 0; index < aVersion.length; index += 1) {
    if (aVersion[index] !== bVersion[index]) {
      return bVersion[index] - aVersion[index];
    }
  }
  return b.syncedAt - a.syncedAt;
}

export function stableHash(input: string, length = PACKAGE_ID_HASH_LENGTH): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

export function resolveHTHAssistantId(baseUrl: string, cliType: string, agent: HTHAgentConfigItem): string {
  const identity = agent.id?.trim() || agent.artifact_key?.trim() || agent.url.trim();
  return `hth-${stableHash(`${baseUrl}|${cliType}|${identity}`, ASSISTANT_ID_HASH_LENGTH)}`;
}

export function resolveHTHPackageId(baseUrl: string, cliType: string, agent: HTHAgentConfigItem): string {
  const identity = agent.id?.trim() || agent.artifact_key?.trim() || agent.url.trim();
  return stableHash(`${baseUrl}|${cliType}|${identity}`);
}

export class HTHPackageStore {
  private readonly rootDir: string;

  constructor(rootDir = path.join(app.getPath('userData'), 'hth', 'agent-packages')) {
    this.rootDir = rootDir;
  }

  getPackageDir(packageId: string, version: string): string {
    return path.join(this.rootDir, packageId, version);
  }

  getZipPath(packageId: string, version: string): string {
    return path.join(this.getPackageDir(packageId, version), 'source.zip');
  }

  getExtractDir(packageId: string, version: string): string {
    return path.join(this.getPackageDir(packageId, version), 'extracted');
  }

  async readManifest(packageId: string, version: string): Promise<HTHPackageManifest | null> {
    try {
      const raw = await fs.readFile(path.join(this.getPackageDir(packageId, version), MANIFEST_FILE), 'utf8');
      return JSON.parse(raw) as HTHPackageManifest;
    } catch {
      return null;
    }
  }

  async writeManifest(manifest: HTHPackageManifest): Promise<void> {
    const packageDir = this.getPackageDir(manifest.packageId, manifest.version);
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');
  }

  async findByAssistantId(assistantId: string): Promise<HTHPackageManifest | null> {
    const manifests = await this.readAllManifests();
    return (
      manifests.filter((manifest) => manifest.assistantId === assistantId).toSorted(compareManifestsByFreshness)[0] ??
      null
    );
  }

  async readAllManifests(): Promise<HTHPackageManifest[]> {
    try {
      const packageIds = await fs.readdir(this.rootDir);
      const manifestsByPackage = await Promise.all(
        packageIds.map(async (packageId) => {
          const packagePath = path.join(this.rootDir, packageId);
          const versions = await fs.readdir(packagePath).catch((): string[] => []);
          const manifests = await Promise.all(versions.map((version) => this.readManifest(packageId, version)));
          return manifests.filter((manifest): manifest is HTHPackageManifest => Boolean(manifest));
        })
      );
      return manifestsByPackage.flat();
    } catch {
      return [];
    }
  }

  async deleteByAssistantId(assistantId: string): Promise<void> {
    const manifests = await this.readAllManifests();
    const packageIds = new Set(
      manifests.filter((manifest) => manifest.assistantId === assistantId).map((manifest) => manifest.packageId)
    );
    await Promise.all(
      Array.from(packageIds).map((packageId) =>
        fs.rm(path.join(this.rootDir, packageId), { force: true, recursive: true })
      )
    );
  }
}
