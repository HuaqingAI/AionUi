import type { HTHAgentConfigItem } from '@/common/types/hth';
import { HTHPackageStore, resolveHTHAssistantId, type HTHPackageManifest } from '@/process/services/hth/packageStore';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

describe('hth package identity', () => {
  const agent: HTHAgentConfigItem = {
    cli_type: 'opencode',
    artifact_key: 'oss://bucket/agent-packages/opencode/demo/1.0.0/opencode.zip',
    url: 'https://oss.test/demo.zip?sig=1',
    url_type: 'https',
    version: '1.0.0',
    name: 'Demo',
  };

  it('keeps the same assistant id for the same artifact across syncs', () => {
    const first = resolveHTHAssistantId('http://localhost:3001', 'opencode', agent);
    const second = resolveHTHAssistantId('http://localhost:3001', 'opencode', {
      ...agent,
      url: 'https://oss.test/demo.zip?sig=2',
      version: '1.0.1',
    });

    expect(first).toBe(second);
  });

  it('uses hth id as the stable identity when it is present', () => {
    const first = resolveHTHAssistantId('http://localhost:3001', 'opencode', { ...agent, id: 'demo' });
    const second = resolveHTHAssistantId('http://localhost:3001', 'opencode', {
      ...agent,
      id: 'demo',
      artifact_key: 'oss://bucket/changed.zip',
      url: 'https://oss.test/changed.zip',
    });

    expect(first).toBe(second);
  });
});

describe('hth package store', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((tempDir) => fs.rm(tempDir, { force: true, recursive: true })));
  });

  it('selects the newest semantic version for an assistant package', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aionui-hth-package-store-'));
    tempDirs.push(rootDir);
    const store = new HTHPackageStore(rootDir);
    await store.writeManifest(createManifest({ version: '1.0.6', syncedAt: 2000 }));
    await store.writeManifest(createManifest({ version: '1.0.10', syncedAt: 1000 }));

    const manifest = await store.findByAssistantId('hth-demo');

    expect(manifest?.version).toBe('1.0.10');
  });

  it('returns null when no assistant package exists', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aionui-hth-package-store-'));
    tempDirs.push(rootDir);
    const store = new HTHPackageStore(rootDir);

    const manifest = await store.findByAssistantId('hth-missing');

    expect(manifest).toBeNull();
  });
});

function createManifest(overrides: Partial<HTHPackageManifest>): HTHPackageManifest {
  const version = overrides.version ?? '1.0.0';
  return {
    packageId: 'package-demo',
    assistantId: 'hth-demo',
    cliType: 'opencode',
    artifactKey: 'oss://bucket/agent-packages/opencode/demo/1.0.0/opencode.zip',
    sourceUrl: 'https://oss.test/demo.zip',
    version,
    name: 'Demo',
    syncedAt: overrides.syncedAt ?? 1000,
    extractDir: `extracted-${version}`,
    globalFiles: [],
    projectFiles: [],
    ...overrides,
  };
}
