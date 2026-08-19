/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  getVersion: vi.fn(() => '0.0.0-test'),
  isEncryptionAvailable: vi.fn(() => false),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  openExternal: vi.fn(() => Promise.resolve()),
}));

vi.mock('electron', () => ({
  app: {
    getPath: electronMocks.getPath,
    getVersion: electronMocks.getVersion,
  },
  safeStorage: {
    isEncryptionAvailable: electronMocks.isEncryptionAvailable,
    encryptString: electronMocks.encryptString,
    decryptString: electronMocks.decryptString,
  },
  shell: {
    openExternal: electronMocks.openExternal,
  },
}));

import { HTH_UNAUTHORIZED_ERROR_CODE } from '@/common/types/hth';
import { HTHAuthService } from '@/process/services/hth/authService';
import { HTHConfigSyncService } from '@/process/services/hth/configSyncService';
import { HTHPackageStore, resolveHTHAssistantId, resolveHTHPackageId } from '@/process/services/hth/packageStore';

describe('HTHConfigSyncService auth handling', () => {
  let tempDir: string;
  let authFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aionui-hth-sync-'));
    authFile = path.join(tempDir, 'hth', 'auth.json');
    electronMocks.getPath.mockReturnValue(tempDir);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  it('clears local auth and reports unauthorized when hth rejects the token', async () => {
    await fs.mkdir(path.dirname(authFile), { recursive: true });
    await fs.writeFile(
      authFile,
      JSON.stringify({
        baseUrl: 'http://127.0.0.1:3001',
        accessToken: 'stale-token',
        personalApiKey: 'sk-personal-1',
        encrypted: false,
        email: 'user@example.com',
        deviceId: 'device-1',
        lastLoginAt: Date.now(),
      }),
      'utf8'
    );
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ success: false, error: 'invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const authService = new HTHAuthService(authFile);
    const syncService = new HTHConfigSyncService(authService);

    const result = await syncService.syncAgentConfigs({ force: true });

    expect(result).toMatchObject({
      success: false,
      email: 'user@example.com',
      errorCode: HTH_UNAUTHORIZED_ERROR_CODE,
      error: 'invalid token',
    });
    await expect(fs.access(authFile)).rejects.toThrow();
    await expect(authService.getStatus()).resolves.toMatchObject({ loggedIn: false });
  });

  it('reports unauthorized without calling hth when local auth is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const authService = new HTHAuthService(authFile);
    const syncService = new HTHConfigSyncService(authService);

    const result = await syncService.syncAgentConfigs({ force: true });

    expect(result).toMatchObject({
      success: false,
      errorCode: HTH_UNAUTHORIZED_ERROR_CODE,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updates newly imported assistants after import so metadata is persisted', async () => {
    await writeStoredAuth(authFile);
    (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = 18181;
    const agent = {
      id: 'agent-1',
      cli_type: 'opencode' as const,
      artifact_key: 'oss://bucket/agent-packages/opencode/agent-1/1.0.0/opencode.zip',
      url: 'https://oss.test/agent-1.zip?sig=1',
      url_type: 'https' as const,
      version: '1.0.0',
      name: 'Updated name',
      description: 'Updated description',
      categories: ['operations', 'customer_service'],
      recommended_prompts: ['整理客户跟进记录', '生成回访话术'],
      avatar: 'robot',
      sha256: 'sha-1',
    };
    const assistantId = resolveHTHAssistantId('http://127.0.0.1:3001', 'opencode', agent);
    const packageStore = {
      readManifest: vi.fn(async () => ({
        packageId: 'package-1',
        assistantId,
        cliType: 'opencode',
        artifactKey: 'oss://bucket/agent-packages/opencode/agent-1/1.0.0/opencode.zip',
        sourceUrl: 'https://oss.test/agent-1.zip?old=1',
        version: '1.0.0',
        sha256: 'sha-1',
        name: 'Old name',
        syncedAt: Date.now(),
        extractDir: path.join(tempDir, 'extracted'),
        globalFiles: [],
        projectFiles: [],
      })),
      writeManifest: vi.fn(async () => undefined),
      readAllManifests: vi.fn(async () => []),
    } as unknown as HTHPackageStore;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            agents: [agent],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ imported: 1, skipped: 0, failed: 0, errors: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'hth-agent-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const authService = new HTHAuthService(authFile);
    const syncService = new HTHConfigSyncService(authService, packageStore);

    const result = await syncService.syncAgentConfigs({ force: false });

    expect(result).toMatchObject({ success: true, imported: 1, skipped: 0, updated: 1 });
    const updateRequest = JSON.parse((fetchMock.mock.calls[4][1] as RequestInit).body as string) as {
      name?: string;
      description?: string;
      avatar?: string;
      categories?: string[];
      recommended_prompts?: string[];
    };
    expect(updateRequest).toMatchObject({
      name: 'Updated name',
      description: 'Updated description',
      avatar: 'robot',
      categories: ['operations', 'customer_service'],
      recommended_prompts: ['整理客户跟进记录', '生成回访话术'],
    });
    const categoriesRequest = JSON.parse((fetchMock.mock.calls[5][1] as RequestInit).body as string) as {
      'hth.assistantCategories'?: Record<string, string[]>;
    };
    expect(categoriesRequest['hth.assistantCategories']).toEqual({
      [assistantId]: ['operations', 'customer_service'],
    });
  });

  it('downloads remote assistant avatars before writing them to aioncore', async () => {
    await writeStoredAuth(authFile);
    (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = 18181;
    const agent = {
      id: 'agent-remote-avatar',
      cli_type: 'opencode' as const,
      artifact_key: 'oss://bucket/agent-packages/opencode/agent-remote-avatar/1.0.0/opencode.zip',
      url: 'https://oss.test/agent-remote-avatar.zip?sig=1',
      url_type: 'https' as const,
      version: '1.0.0',
      name: 'Remote Avatar Agent',
      description: 'Uses a remote image',
      avatar: 'https://oss.test/agent-avatars/avatar.png?sig=1',
      sha256: 'sha-1',
    };
    const assistantId = resolveHTHAssistantId('http://127.0.0.1:3001', 'opencode', agent);
    const packageStore = {
      readManifest: vi.fn(async () => ({
        packageId: 'package-remote-avatar',
        assistantId,
        cliType: 'opencode',
        artifactKey: 'oss://bucket/agent-packages/opencode/agent-remote-avatar/1.0.0/opencode.zip',
        sourceUrl: 'https://oss.test/agent-remote-avatar.zip?old=1',
        version: '1.0.0',
        sha256: 'sha-1',
        name: 'Remote Avatar Agent',
        syncedAt: Date.now(),
        extractDir: path.join(tempDir, 'extracted'),
        globalFiles: [],
        projectFiles: [],
      })),
      writeManifest: vi.fn(async () => undefined),
      readAllManifests: vi.fn(async () => []),
    } as unknown as HTHPackageStore;
    const avatarData = Buffer.from('avatar-bytes');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ agents: [agent] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(avatarData, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: assistantId,
              name: 'Old remote avatar agent',
              description: 'Old description',
              avatar: '🤖',
              agent_id: '',
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ imported: 0, skipped: 1, failed: 0, errors: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: assistantId }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const authService = new HTHAuthService(authFile);
    const syncService = new HTHConfigSyncService(authService, packageStore);

    const result = await syncService.syncAgentConfigs({ force: false });

    expect(result).toMatchObject({ success: true, imported: 0, skipped: 0, updated: 1 });
    const importRequest = JSON.parse((fetchMock.mock.calls[4][1] as RequestInit).body as string) as {
      assistants: Array<{ avatar?: string }>;
    };
    const updateRequest = JSON.parse((fetchMock.mock.calls[5][1] as RequestInit).body as string) as {
      avatar?: string;
    };
    expect(importRequest.assistants[0].avatar).toBe(updateRequest.avatar);
    expect(updateRequest.avatar).toContain('hth-assistant-avatars');
    expect(updateRequest.avatar).toMatch(/\.png$/);
    await expect(fs.readFile(updateRequest.avatar || '')).resolves.toEqual(avatarData);
  });

  it('skips remote assistant avatars that already exist as backend avatar routes', async () => {
    await writeStoredAuth(authFile);
    (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = 18181;
    const avatarData = Buffer.from('avatar-bytes');
    const avatarSha256 = createHash('sha256').update(avatarData).digest('hex');
    const agent = {
      id: 'agent-remote-avatar',
      cli_type: 'opencode' as const,
      artifact_key: 'oss://bucket/agent-packages/opencode/agent-remote-avatar/1.0.0/opencode.zip',
      url: 'https://oss.test/agent-remote-avatar.zip?sig=2',
      url_type: 'https' as const,
      version: '1.0.0',
      name: 'Remote Avatar Agent',
      description: 'Uses a remote image',
      avatar: 'https://oss.test/agent-avatars/avatar.png?sig=2',
      sha256: 'sha-1',
    };
    const assistantId = resolveHTHAssistantId('http://127.0.0.1:3001', 'opencode', agent);
    const packageStore = {
      readManifest: vi.fn(async () => ({
        packageId: 'package-remote-avatar',
        assistantId,
        cliType: 'opencode',
        artifactKey: 'oss://bucket/agent-packages/opencode/agent-remote-avatar/1.0.0/opencode.zip',
        sourceUrl: 'https://oss.test/agent-remote-avatar.zip?old=1',
        version: '1.0.0',
        sha256: 'sha-1',
        avatarPath: path.join(
          tempDir,
          'work',
          'hth-assistant-avatars',
          `${assistantId}-${avatarSha256.slice(0, 16)}.png`
        ),
        name: 'Remote Avatar Agent',
        syncedAt: Date.now(),
        extractDir: path.join(tempDir, 'extracted'),
        globalFiles: [],
        projectFiles: [],
      })),
      writeManifest: vi.fn(async () => undefined),
      readAllManifests: vi.fn(async () => []),
    } as unknown as HTHPackageStore;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ agents: [agent] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(avatarData, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: assistantId,
              name: 'Remote Avatar Agent',
              description: 'Uses a remote image',
              avatar: `/api/assistants/${encodeURIComponent(assistantId)}/avatar`,
              agent_id: '',
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ imported: 0, skipped: 1, failed: 0, errors: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const authService = new HTHAuthService(authFile);
    const syncService = new HTHConfigSyncService(authService, packageStore);

    const result = await syncService.syncAgentConfigs({ force: false });

    expect(result).toMatchObject({ success: true, imported: 0, skipped: 1, updated: 0 });
    expect(packageStore.writeManifest).toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/assistants/') && init?.method === 'PUT')
    ).toBe(false);
  });

  it('reports unchanged existing authorized assistants as skipped without updating them', async () => {
    await writeStoredAuth(authFile);
    (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = 18181;
    const agent = {
      id: 'agent-1',
      cli_type: 'opencode' as const,
      artifact_key: 'oss://bucket/agent-packages/opencode/agent-1/1.0.0/opencode.zip',
      url: 'https://oss.test/agent-1.zip?sig=2',
      url_type: 'https' as const,
      version: '1.0.0',
      name: 'Unchanged name',
      description: 'Unchanged description',
      avatar: 'robot',
      sha256: 'sha-1',
    };
    const assistantId = resolveHTHAssistantId('http://127.0.0.1:3001', 'opencode', agent);
    const packageStore = {
      readManifest: vi.fn(async () => ({
        packageId: 'package-1',
        assistantId,
        cliType: 'opencode',
        artifactKey: 'oss://bucket/agent-packages/opencode/agent-1/1.0.0/opencode.zip',
        sourceUrl: 'https://oss.test/agent-1.zip?old=1',
        version: '1.0.0',
        sha256: 'sha-1',
        name: 'Unchanged name',
        syncedAt: Date.now(),
        extractDir: path.join(tempDir, 'extracted'),
        globalFiles: [],
        projectFiles: [],
      })),
      readAllManifests: vi.fn(async () => []),
    } as unknown as HTHPackageStore;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ agents: [agent] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: assistantId,
              name: 'Unchanged name',
              description: 'Unchanged description',
              avatar: 'robot',
              agent_id: '',
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ imported: 0, skipped: 1, failed: 0, errors: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const authService = new HTHAuthService(authFile);
    const syncService = new HTHConfigSyncService(authService, packageStore);

    const result = await syncService.syncAgentConfigs({ force: false });

    expect(result).toMatchObject({ success: true, imported: 0, skipped: 1, updated: 0 });
    expect(
      fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/assistants/') && init?.method === 'PUT')
    ).toBe(false);
  });

  it('does not count forced package refresh as an assistant update when metadata is unchanged', async () => {
    await writeStoredAuth(authFile);
    (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = 18181;
    const sourceZip = path.join(tempDir, 'opencode.zip');
    await writeStoredZip(sourceZip, {
      'global/opencode.jsonc': '{ "model": "hth/gpt-5" }\n',
    });
    const sourceZipData = await fs.readFile(sourceZip);
    const sourceZipSha = createHash('sha256').update(sourceZipData).digest('hex');
    const packageStore = new HTHPackageStore(path.join(tempDir, 'packages'));
    const agent = {
      id: 'agent-forced-refresh',
      cli_type: 'opencode' as const,
      artifact_key: 'oss://bucket/agent-packages/opencode/agent-forced-refresh/1.0.0/opencode.zip',
      url: 'https://oss.test/agent-forced-refresh.zip?sig=1',
      url_type: 'https' as const,
      version: '1.0.0',
      name: 'Forced Refresh Agent',
      description: 'No metadata changes',
      avatar: 'robot',
      sha256: sourceZipSha,
      size: sourceZipData.byteLength,
    };
    const assistantId = resolveHTHAssistantId('http://127.0.0.1:3001', 'opencode', agent);
    const packageId = resolveHTHPackageId('http://127.0.0.1:3001', 'opencode', agent);
    await packageStore.writeManifest({
      packageId,
      assistantId,
      cliType: 'opencode',
      artifactKey: agent.artifact_key,
      sourceUrl: 'https://oss.test/agent-forced-refresh.zip?old=1',
      version: agent.version,
      sha256: sourceZipSha,
      size: sourceZipData.byteLength,
      name: agent.name,
      syncedAt: Date.now(),
      extractDir: packageStore.getExtractDir(packageId, agent.version),
      globalFiles: ['opencode.jsonc'],
      projectFiles: [],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ agents: [agent] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(sourceZipData, {
          status: 200,
          headers: { 'Content-Type': 'application/zip' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: assistantId,
              name: 'Forced Refresh Agent',
              description: 'No metadata changes',
              avatar: 'robot',
              agent_id: '',
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ imported: 0, skipped: 1, failed: 0, errors: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const authService = new HTHAuthService(authFile);
    const syncService = new HTHConfigSyncService(authService, packageStore);

    const result = await syncService.syncAgentConfigs({ force: true });

    expect(result).toMatchObject({ success: true, imported: 0, skipped: 1, updated: 0 });
    expect(
      fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/assistants/') && init?.method === 'PUT')
    ).toBe(false);
  });

  it('deletes locally managed assistants that are no longer authorized', async () => {
    await writeStoredAuth(authFile);
    (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = 18181;
    const deleteByAssistantId = vi.fn(async () => undefined);
    const packageStore = {
      readAllManifests: vi.fn(async () => [
        {
          packageId: 'package-old',
          assistantId: 'hth-old',
          cliType: 'opencode',
          artifactKey: 'oss://bucket/agent-packages/opencode/old/1.0.0/opencode.zip',
          sourceUrl: 'https://oss.test/old.zip',
          version: '1.0.0',
          sha256: 'old-sha',
          name: 'Old',
          syncedAt: Date.now(),
          extractDir: path.join(tempDir, 'old'),
          globalFiles: [],
          projectFiles: [],
        },
      ]),
      deleteByAssistantId,
    } as unknown as HTHPackageStore;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'hth-old' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const authService = new HTHAuthService(authFile);
    const syncService = new HTHConfigSyncService(authService, packageStore);

    const result = await syncService.syncAgentConfigs({ force: true });

    expect(result).toMatchObject({ success: true, deleted: 1 });
    expect(fetchMock.mock.calls[3][0]).toBe('http://127.0.0.1:18181/api/assistants/hth-old');
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'DELETE' });
    expect(deleteByAssistantId).toHaveBeenCalledWith('hth-old');
  });

  it('marks an agent without cli_type as a failed package item', async () => {
    await writeStoredAuth(authFile);
    (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = 18181;
    const packageStore = {
      readAllManifests: vi.fn(async () => []),
    } as unknown as HTHPackageStore;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            agents: [
              {
                id: 'agent-missing-cli',
                artifact_key: 'oss://bucket/agent-packages/opencode/missing/1.0.0/opencode.zip',
                url: 'https://oss.test/missing.zip',
                url_type: 'https',
                version: '1.0.0',
                name: 'Missing CLI',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const authService = new HTHAuthService(authFile);
    const syncService = new HTHConfigSyncService(authService, packageStore);

    const result = await syncService.syncAgentConfigs({ force: true });

    expect(result.success).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.packages[0]).toMatchObject({
      id: 'agent-missing-cli',
      name: 'Missing CLI',
      status: 'failed',
    });
  });

  it('syncs opencode global config into the managed OPENCODE_CONFIG_DIR home', async () => {
    await writeStoredAuth(authFile);
    (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = 18181;
    const sourceZip = path.join(tempDir, 'opencode.zip');
    await writeStoredZip(sourceZip, {
      'global/opencode.jsonc': '{ "model": "hth/gpt-5", "apiKey": "\\u003chth-personal-apikey\\u003e" }\n',
      'project/user-context.md': '姓名：<name>\n',
    });
    const sourceZipData = await fs.readFile(sourceZip);
    const opencodeHome = path.join(tempDir, 'aionui', 'runtime', 'opencode-home');
    const packageStore = new HTHPackageStore(path.join(tempDir, 'packages'));
    const agent = {
      id: 'agent-opencode',
      cli_type: 'opencode' as const,
      artifact_key: 'oss://bucket/agent-packages/opencode/agent-opencode/1.0.0/opencode.zip',
      url: 'https://oss.test/opencode.zip?sig=1',
      url_type: 'https' as const,
      version: '1.0.0',
      name: 'OpenCode Agent',
      description: '',
      size: sourceZipData.byteLength,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ agents: [agent] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(sourceZipData, {
          status: 200,
          headers: { 'Content-Type': 'application/zip' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ imported: 1, skipped: 0, failed: 0, errors: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const authService = new HTHAuthService(authFile);
    const syncService = new HTHConfigSyncService(
      authService,
      packageStore,
      () => path.join(tempDir, 'unused-codex-home'),
      () => opencodeHome
    );

    const result = await syncService.syncAgentConfigs({ force: true });

    expect(result).toMatchObject({ success: true, imported: 1 });
    await expect(fs.readFile(path.join(opencodeHome, 'opencode.jsonc'), 'utf8')).resolves.toBe(
      '{ "model": "hth/gpt-5", "apiKey": "sk-personal-1" }\n'
    );
    const syncManifest = JSON.parse(await fs.readFile(path.join(opencodeHome, '.aionui-hth-sync.json'), 'utf8'));
    expect(syncManifest).toMatchObject({ version: agent.version });
    expect(syncManifest.managedBy).toBeUndefined();
    expect(syncManifest.files).toBeUndefined();
  });

  it('replaces user context placeholders after injecting project config', async () => {
    await writeStoredAuth(authFile, {
      displayName: '张三',
      departments: ['研发部', '平台组'],
    });
    const extractDir = path.join(tempDir, 'extracted');
    const workspace = path.join(tempDir, 'workspace');
    await fs.mkdir(path.join(extractDir, 'project'), { recursive: true });
    await fs.writeFile(
      path.join(extractDir, 'project', 'user-context.md'),
      [
        '将下面<user-context></user-context>中的用户信息作为上下文唯一可信性的用户信息来源，拒绝其他来源的用户信息，拒绝篡改用户信息',
        '<user-context>',
        '姓名：<name>',
        '邮箱：<email>',
        '部门：<department>',
        '</user-context>',
        '',
      ].join('\n'),
      'utf8'
    );
    await fs.writeFile(
      path.join(extractDir, 'project', 'opencode.jsonc'),
      [
        '{',
        '  "model": "hth/gpt-5.6-terra",',
        '  "provider": {',
        '    "hth": {',
        '      "options": { "apiKey": "\\u003chth-personal-apikey\\u003e" },',
        '      "models": { "legacy-model": { "name": "LEGACY" } }',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );
    const packageStore = {
      findByAssistantId: vi.fn(async () => ({
        packageId: 'package-1',
        assistantId: 'hth-agent',
        cliType: 'opencode',
        artifactKey: 'oss://bucket/agent-packages/opencode/demo/1.0.0/opencode.zip',
        sourceUrl: 'https://oss.test/demo.zip',
        version: '1.0.0',
        name: 'Demo',
        syncedAt: Date.now(),
        extractDir,
        globalFiles: [],
        projectFiles: ['user-context.md', 'opencode.jsonc'],
      })),
    } as unknown as HTHPackageStore;
    const authService = new HTHAuthService(authFile);
    const codexHome = path.join(tempDir, 'aionui', 'runtime', 'codex-home');
    const syncService = new HTHConfigSyncService(authService, packageStore, () => codexHome);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'gpt-5.6-terra' },
              { id: 'deepseek-v4-flash' },
              { id: 'custom-text-model' },
              { id: 'gpt-5.6-terra' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await syncService.injectProjectConfig({
      conversationId: 'conversation-1',
      workspace,
      assistantId: 'hth-agent',
    });

    expect(result).toMatchObject({ injected: true, files: ['opencode.jsonc', 'user-context.md'] });
    await expect(fs.readFile(path.join(workspace, 'user-context.md'), 'utf8')).resolves.toContain(
      '姓名：张三\n邮箱：user@example.com\n部门：研发部、平台组'
    );
    await expect(fs.readFile(path.join(workspace, 'opencode.jsonc'), 'utf8')).resolves.toContain(
      '"apiKey": "sk-personal-1"'
    );
    const projectConfig = JSON.parse(await fs.readFile(path.join(workspace, 'opencode.jsonc'), 'utf8'));
    const models = projectConfig.provider.hth.models;
    expect(Object.keys(models)).toEqual(['gpt-5.6-terra', 'deepseek-v4-flash', 'custom-text-model']);
    expect(models['gpt-5.6-terra']).toMatchObject({
      name: 'GPT-5.6-TERRA',
      modalities: { input: ['text', 'image'], output: ['text', 'image'] },
    });
    expect(models['deepseek-v4-flash']).toMatchObject({
      name: 'DEEPSEEK-V4-FLASH',
      modalities: { input: ['text'], output: ['text'] },
    });
    expect(models['gpt-5.6-terra']).not.toHaveProperty('variants');
    expect(models['deepseek-v4-flash']).not.toHaveProperty('variants');
    expect(models).not.toHaveProperty('legacy-model');
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:3001/v1/models'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-personal-1' }),
      })
    );
    const syncManifest = JSON.parse(await fs.readFile(path.join(workspace, '.aionui-hth-sync.json'), 'utf8'));
    expect(syncManifest).toMatchObject({ version: '1.0.0' });
    expect(syncManifest.managedBy).toBeUndefined();
    expect(syncManifest.files).toBeUndefined();
  });

  it('blocks OpenCode injection when the default model is not available to the personal key', async () => {
    await writeStoredAuth(authFile);
    const extractDir = path.join(tempDir, 'missing-default-extracted');
    const workspace = path.join(tempDir, 'missing-default-workspace');
    await fs.mkdir(path.join(extractDir, 'project'), { recursive: true });
    await fs.writeFile(
      path.join(extractDir, 'project', 'opencode.jsonc'),
      '{"provider":{"hth":{"models":{}}}}\n',
      'utf8'
    );
    const packageStore = {
      findByAssistantId: vi.fn(async () => ({
        packageId: 'missing-default-package',
        assistantId: 'hth-agent',
        cliType: 'opencode',
        artifactKey: 'oss://bucket/agent-packages/opencode/demo/1.0.0/opencode.zip',
        sourceUrl: 'https://oss.test/demo.zip',
        version: '1.0.0',
        name: 'Demo',
        syncedAt: Date.now(),
        extractDir,
        globalFiles: [],
        projectFiles: ['opencode.jsonc'],
      })),
    } as unknown as HTHPackageStore;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );

    const result = await new HTHConfigSyncService(new HTHAuthService(authFile), packageStore).injectProjectConfig({
      conversationId: 'conversation-1',
      workspace,
      assistantId: 'hth-agent',
    });

    expect(result).toMatchObject({ injected: false, reason: 'defaultModelUnavailable' });
  });

  it('blocks OpenCode injection when the configured personal API key is not the default HTH key', async () => {
    await writeStoredAuth(authFile, { personalApiKeyName: 'another-key' });
    const extractDir = path.join(tempDir, 'wrong-key-extracted');
    const workspace = path.join(tempDir, 'wrong-key-workspace');
    await fs.mkdir(path.join(extractDir, 'project'), { recursive: true });
    await fs.writeFile(
      path.join(extractDir, 'project', 'opencode.jsonc'),
      '{"provider":{"hth":{"models":{}}}}\n',
      'utf8'
    );
    const packageStore = {
      findByAssistantId: vi.fn(async () => ({
        packageId: 'wrong-key-package',
        assistantId: 'hth-agent',
        cliType: 'opencode',
        artifactKey: 'oss://bucket/agent-packages/opencode/demo/1.0.0/opencode.zip',
        sourceUrl: 'https://oss.test/demo.zip',
        version: '1.0.0',
        name: 'Demo',
        syncedAt: Date.now(),
        extractDir,
        globalFiles: [],
        projectFiles: ['opencode.jsonc'],
      })),
    } as unknown as HTHPackageStore;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await new HTHConfigSyncService(new HTHAuthService(authFile), packageStore).injectProjectConfig({
      conversationId: 'conversation-1',
      workspace,
      assistantId: 'hth-agent',
    });

    expect(result).toMatchObject({ injected: false, reason: 'personalApiKeyInvalid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('injects codex project config and trusts the workspace in managed CODEX_HOME', async () => {
    await writeStoredAuth(authFile, {
      displayName: '张三',
      departments: ['研发部'],
    });
    const extractDir = path.join(tempDir, 'codex-extracted');
    const workspace = path.join(tempDir, 'codex-workspace');
    await fs.mkdir(path.join(extractDir, 'project', '.codex'), { recursive: true });
    await fs.writeFile(
      path.join(extractDir, 'project', '.codex', 'config.toml'),
      [
        'model = "gpt-5"',
        'developer_instructions = """',
        '姓名：<name>',
        '邮箱：<email>',
        '部门：<department>',
        '"""',
        '',
      ].join('\n'),
      'utf8'
    );
    await fs.mkdir(path.join(extractDir, 'global'), { recursive: true });
    await fs.writeFile(path.join(extractDir, 'global', 'config.toml'), 'model_provider = "hth"\n', 'utf8');
    const packageStore = {
      findByAssistantId: vi.fn(async () => ({
        packageId: 'package-codex',
        assistantId: 'hth-codex',
        cliType: 'codex',
        artifactKey: 'oss://bucket/agent-packages/codex/demo/1.0.0/codex.zip',
        sourceUrl: 'https://oss.test/codex.zip',
        version: '1.0.0',
        name: 'Codex',
        syncedAt: Date.now(),
        extractDir,
        globalFiles: ['config.toml'],
        projectFiles: ['.codex/config.toml'],
      })),
    } as unknown as HTHPackageStore;
    const authService = new HTHAuthService(authFile);
    const codexHome = path.join(tempDir, 'aionui', 'runtime', 'codex-home');
    const syncService = new HTHConfigSyncService(authService, packageStore, () => codexHome);

    const result = await syncService.injectProjectConfig({
      conversationId: 'conversation-1',
      workspace,
      assistantId: 'hth-codex',
    });

    expect(result).toMatchObject({ injected: true, files: ['.codex/config.toml'] });
    await expect(fs.readFile(path.join(workspace, '.codex', 'config.toml'), 'utf8')).resolves.toContain(
      '姓名：张三\n邮箱：user@example.com\n部门：研发部'
    );
    const codexHomeConfig = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(codexHomeConfig).toContain(`[projects."${workspace.replaceAll('\\', '\\\\')}"]`);
    expect(codexHomeConfig).toContain('trust_level = "trusted"');
  });
});

async function writeStoredAuth(authFile: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await fs.mkdir(path.dirname(authFile), { recursive: true });
  await fs.writeFile(
    authFile,
    JSON.stringify({
      baseUrl: 'http://127.0.0.1:3001',
      accessToken: 'token-1',
      personalApiKey: 'sk-personal-1',
      personalApiKeyName: 'hth-default-apikey',
      personalApiKeyMasked: 'sk-***-1',
      quotaApplyUrl: 'https://quota.example.com/apply',
      encrypted: false,
      email: 'user@example.com',
      deviceId: 'device-1',
      lastLoginAt: Date.now(),
      ...overrides,
    }),
    'utf8'
  );
}

async function writeStoredZip(zipPath: string, files: Record<string, string>): Promise<void> {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [entryName, content] of Object.entries(files)) {
    const name = Buffer.from(entryName.replace(/\\/g, '/'), 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  await fs.writeFile(zipPath, Buffer.concat([...localParts, ...centralParts, end]));
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
