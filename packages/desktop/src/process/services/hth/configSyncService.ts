/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Assistant,
  CreateAssistantRequest,
  ImportAssistantsResult,
  UpdateAssistantRequest,
} from '@/common/types/agent/assistantTypes';
import type {
  HTHAgentConfigItem,
  HTHAgentConfigs,
  HTHCliType,
  HTHInjectProjectConfigRequest,
  HTHInjectProjectConfigResult,
  HTHSyncAgentConfigsRequest,
  HTHSyncPackageResult,
  HTHSyncResult,
} from '@/common/types/hth';
import { HTH_UNAUTHORIZED_ERROR_CODE } from '@/common/types/hth';
import type { HTHAuthService } from './authService';
import { HTHPackageStore, resolveHTHAssistantId, resolveHTHPackageId } from './packageStore';
import type { HTHPackageManifest } from './packageStore';
import { assertPathInside, copyManagedSection, extractZip } from './zipSecurity';
import { getSystemDir } from '@/process/utils/initStorage';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

type ManagedAgentRow = {
  id?: string;
  name?: string;
  backend?: string;
  agent_type?: string;
  enabled?: boolean;
  status?: string;
};

type AssistantWriteResult = {
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
};

type PackageSyncOutcome = {
  manifest: HTHPackageManifest;
  changed: boolean;
  existing: boolean;
};

type PreparedAssistantAvatar = {
  value?: string;
  sha256?: string;
};

type ApiEnvelope<T> = {
  success?: boolean;
  data?: T;
  error?: string;
  msg?: string;
};

type HTHAccess = {
  baseUrl: string;
  token: string;
  email: string;
  displayName?: string;
  username?: string;
  departments?: string[];
  personalApiKey: string;
  quotaApplyUrl?: string;
};

const MANAGED_AGENT_MATCH: Record<HTHCliType, string> = {
  opencode: 'opencode',
  codex: 'codex',
};
const HTH_PERSONAL_API_KEY_PLACEHOLDER = '<hth-personal-apikey>';
const HTH_PERSONAL_API_KEY_PLACEHOLDER_JSON_ESCAPED = '\\u003chth-personal-apikey\\u003e';
const HTH_LOGIN_REQUIRED_MESSAGE = 'hth login required';
const HTH_ASSISTANT_CATEGORIES_SETTING = 'hth.assistantCategories';
const MAX_AGENT_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_ASSISTANT_AVATAR_BYTES = 2 * 1024 * 1024;
const ASSISTANT_AVATAR_DIR_NAME = 'hth-assistant-avatars';

function defaultCodexHomeDir(): string {
  return path.join(getSystemDir().workDir, 'runtime', 'codex-home');
}

function defaultOpenCodeConfigDir(): string {
  return path.join(getSystemDir().workDir, 'runtime', 'opencode-home');
}

class HTHUnauthorizedConfigError extends Error {
  constructor(message = HTH_LOGIN_REQUIRED_MESSAGE) {
    super(message);
    this.name = 'HTHUnauthorizedConfigError';
  }
}

export class HTHConfigSyncService {
  constructor(
    private readonly authService: HTHAuthService,
    private readonly packageStore = new HTHPackageStore(),
    private readonly resolveCodexHomeDir = defaultCodexHomeDir,
    private readonly resolveOpenCodeConfigDir = defaultOpenCodeConfigDir
  ) {}

  async syncAgentConfigs(request: HTHSyncAgentConfigsRequest): Promise<HTHSyncResult> {
    const access = await this.getAccessOrLogout();
    if (!access) {
      return this.authRequiredSyncResult();
    }

    let configs: HTHAgentConfigs;
    try {
      configs = await this.fetchConfigs(access.baseUrl, access.token);
    } catch (error) {
      if (error instanceof HTHUnauthorizedConfigError) {
        await this.authService.logout();
        return this.authRequiredSyncResult(access.email, error.message);
      }
      throw error;
    }

    const managedAgentIds = await this.resolveManagedAgentIds();
    const packageResults: HTHSyncPackageResult[] = [];
    const assistants: CreateAssistantRequest[] = [];
    const currentAssistantIds = new Set<string>();
    const unchangedRemoteAvatarIds = new Set<string>();

    for (const agent of configs.agents) {
      let packageId = agent.id?.trim() || agent.url || agent.name;
      try {
        const cliType = this.requireAgentCliType(agent);
        const assistantId = resolveHTHAssistantId(access.baseUrl, cliType, agent);
        packageId = resolveHTHPackageId(access.baseUrl, cliType, agent);
        currentAssistantIds.add(assistantId);
        // eslint-disable-next-line no-await-in-loop -- package sync is intentionally ordered for deterministic results.
        const outcome = await this.syncPackage({
          agent,
          assistantId,
          baseUrl: access.baseUrl,
          cliType,
          access,
          packageId,
          force: request.force === true,
        });
        // eslint-disable-next-line no-await-in-loop -- avatar preparation belongs to the same ordered agent sync step.
        const avatar = await this.prepareAssistantAvatar(agent.avatar, assistantId);
        const previousAvatarSha256 = outcome.manifest.avatarSha256;
        if (avatar.sha256 && (!previousAvatarSha256 || avatar.sha256 === previousAvatarSha256)) {
          unchangedRemoteAvatarIds.add(assistantId);
        }
        const avatarManifestChanged = avatar.sha256
          ? avatar.sha256 !== previousAvatarSha256 || avatar.value !== outcome.manifest.avatarPath
          : outcome.manifest.avatarSha256 !== undefined || outcome.manifest.avatarPath !== undefined;
        if (avatarManifestChanged) {
          outcome.manifest.avatarSha256 = avatar.sha256;
          outcome.manifest.avatarPath = avatar.sha256 ? avatar.value : undefined;
          // eslint-disable-next-line no-await-in-loop -- manifest metadata belongs to the same ordered agent sync step.
          await this.packageStore.writeManifest(outcome.manifest);
        }
        assistants.push(this.mapAssistant(agent, assistantId, managedAgentIds.get(cliType), avatar.value));
        packageResults.push({
          id: outcome.manifest.packageId,
          name: agent.name,
          version: agent.version,
          status: this.packageResultStatus(outcome),
        });
      } catch (error) {
        packageResults.push({
          id: packageId,
          name: agent.name,
          version: agent.version,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const existingAssistants =
      assistants.length > 0 ? await this.listAssistants(this.requireBackendPort()) : new Map<string, Assistant>();
    const importResult = assistants.length > 0 ? await this.importAssistants(assistants) : this.emptyImportResult();
    const updateResult =
      assistants.length > 0
        ? await this.updateAssistants(assistants, existingAssistants, unchangedRemoteAvatarIds)
        : this.emptyAssistantWriteResult();
    if (assistants.some((assistant) => (assistant.categories?.length ?? 0) > 0)) {
      await this.persistAssistantCategories(assistants);
    }
    const deleteResult = await this.deleteRevokedAssistants(currentAssistantIds);
    return {
      success:
        packageResults.every((item) => item.status !== 'failed') &&
        importResult.failed === 0 &&
        updateResult.failed === 0 &&
        deleteResult.failed === 0,
      email: configs.user_email || access.email,
      revision: configs.revision,
      imported: importResult.imported,
      skipped: updateResult.skipped,
      failed:
        importResult.failed +
        updateResult.failed +
        deleteResult.failed +
        packageResults.filter((item) => item.status === 'failed').length,
      updated: updateResult.updated,
      deleted: deleteResult.deleted,
      packages: packageResults,
      lastSyncedAt: Date.now(),
    };
  }

  async injectProjectConfig(request: HTHInjectProjectConfigRequest): Promise<HTHInjectProjectConfigResult> {
    if (!request.assistantId) {
      return { injected: false, files: [], reason: 'assistantNotManaged' };
    }
    if (!request.workspace) {
      return { injected: false, files: [], reason: 'workspaceMissing' };
    }

    const manifest = await this.packageStore.findByAssistantId(request.assistantId);
    if (!manifest) {
      return { injected: false, files: [], reason: 'assistantNotManaged' };
    }
    if (manifest.projectFiles.length === 0) {
      return { injected: false, files: [], reason: 'projectConfigMissing' };
    }

    const copied = await copyManagedSection(manifest.extractDir, 'project', request.workspace, manifest.version);
    const access = await this.getAccessOrLogout();
    if (access) {
      await this.replaceRuntimePlaceholdersInFiles(request.workspace, copied, access);
    }
    if (manifest.cliType === 'codex') {
      await this.ensureCodexTrustedWorkspace(request.workspace);
    }
    return { injected: copied.length > 0, files: copied };
  }

  private async fetchConfigs(baseUrl: string, token: string): Promise<HTHAgentConfigs> {
    const url = new URL('/api/aionui/agent-configs', baseUrl);
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    const rawText = await response.text();
    if (response.status === 401) {
      throw new HTHUnauthorizedConfigError(this.extractErrorMessage(rawText) || HTH_LOGIN_REQUIRED_MESSAGE);
    }

    let parsed: ApiEnvelope<HTHAgentConfigs> | HTHAgentConfigs;
    try {
      parsed = JSON.parse(rawText) as ApiEnvelope<HTHAgentConfigs> | HTHAgentConfigs;
    } catch {
      throw new Error(`hth config request failed: ${response.status}`);
    }
    if (!response.ok) {
      const envelope = parsed as ApiEnvelope<HTHAgentConfigs>;
      throw new Error(envelope.error || envelope.msg || `hth config request failed: ${response.status}`);
    }
    if ('data' in parsed && parsed.data) {
      return parsed.data;
    }
    return parsed as HTHAgentConfigs;
  }

  private requireAgentCliType(agent: HTHAgentConfigItem): HTHCliType {
    if (agent.cli_type === 'opencode' || agent.cli_type === 'codex') {
      return agent.cli_type;
    }
    throw new Error(`Unsupported agent cli_type: ${String(agent.cli_type)}`);
  }

  private async getAccessOrLogout(): Promise<HTHAccess | null> {
    try {
      return await this.authService.getAccess();
    } catch (error) {
      if (this.isLoginRequiredError(error)) {
        await this.authService.logout();
        return null;
      }
      throw error;
    }
  }

  private async replaceRuntimePlaceholdersInFiles(rootDir: string, files: string[], access: HTHAccess): Promise<void> {
    await Promise.all(
      files.map(async (relativeFile) => {
        const filePath = path.join(rootDir, relativeFile);
        assertPathInside(rootDir, filePath);
        if (this.isTextConfigFile(filePath)) {
          await this.replacePlaceholdersInFile(filePath, access);
        }
      })
    );
  }

  private async replacePlaceholdersInFile(filePath: string, access: HTHAccess): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return;
    }
    const nextContent = this.replaceUserPlaceholders(content, access);
    if (nextContent !== content) {
      await fs.writeFile(filePath, nextContent, 'utf8');
    }
  }

  private replaceUserPlaceholders(content: string, access: HTHAccess): string {
    const userName = (access.displayName || access.username || access.email || '').trim();
    const department = (access.departments ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
      .join('、');
    return content
      .replaceAll('<name>', userName)
      .replaceAll('<email>', access.email.trim())
      .replaceAll('<department>', department)
      .replaceAll(HTH_PERSONAL_API_KEY_PLACEHOLDER, access.personalApiKey)
      .replaceAll(HTH_PERSONAL_API_KEY_PLACEHOLDER_JSON_ESCAPED, access.personalApiKey);
  }

  private isTextConfigFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (!ext) {
      return true;
    }
    return new Set(['.json', '.jsonc', '.toml', '.yaml', '.yml', '.md', '.txt', '.conf']).has(ext);
  }

  private async ensureCodexTrustedWorkspace(workspace: string): Promise<void> {
    const codexHome = this.codexHomeDir();
    const configPath = path.join(codexHome, 'config.toml');
    await fs.mkdir(codexHome, { recursive: true });
    let content = '';
    try {
      content = await fs.readFile(configPath, 'utf8');
    } catch {
      content = '';
    }
    const nextContent = this.upsertCodexTrustedWorkspace(content, workspace);
    if (nextContent !== content) {
      await fs.writeFile(configPath, nextContent, 'utf8');
    }
  }

  private upsertCodexTrustedWorkspace(content: string, workspace: string): string {
    const header = `[projects.${this.tomlQuotedKey(path.resolve(workspace))}]`;
    const block = `${header}\ntrust_level = "trusted"\n`;
    const start = content.indexOf(header);
    if (start < 0) {
      const prefix = content.trimEnd();
      return `${prefix}${prefix ? '\n\n' : ''}${block}`;
    }
    const afterHeader = content.indexOf('\n[', start + header.length);
    const end = afterHeader < 0 ? content.length : afterHeader + 1;
    return `${content.slice(0, start)}${block}${content.slice(end)}`;
  }

  private tomlQuotedKey(value: string): string {
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  }

  private isLoginRequiredError(error: unknown): boolean {
    return error instanceof Error && error.message === HTH_LOGIN_REQUIRED_MESSAGE;
  }

  private extractErrorMessage(rawText: string): string | undefined {
    try {
      const parsed = JSON.parse(rawText) as ApiEnvelope<unknown>;
      return parsed.error || parsed.msg;
    } catch {
      return undefined;
    }
  }

  private authRequiredSyncResult(email?: string, error = HTH_LOGIN_REQUIRED_MESSAGE): HTHSyncResult {
    return {
      success: false,
      email,
      imported: 0,
      skipped: 0,
      failed: 0,
      packages: [],
      lastSyncedAt: Date.now(),
      errorCode: HTH_UNAUTHORIZED_ERROR_CODE,
      error,
    };
  }

  private async syncPackage(params: {
    agent: HTHAgentConfigItem;
    assistantId: string;
    baseUrl: string;
    cliType: HTHCliType;
    access: HTHAccess;
    packageId: string;
    force: boolean;
  }): Promise<PackageSyncOutcome> {
    const manifest = await this.packageStore.readManifest(params.packageId, params.agent.version);
    if (!params.force && manifest && this.isPackageManifestCurrent(manifest, params.agent)) {
      return { manifest, changed: false, existing: true };
    }

    const zipPath = this.packageStore.getZipPath(params.packageId, params.agent.version);
    const extractDir = this.packageStore.getExtractDir(params.packageId, params.agent.version);
    await fs.mkdir(path.dirname(zipPath), { recursive: true });
    await this.writePackageZip(params.agent, zipPath);
    const actualHash = await this.calculateSha256(zipPath);
    if (params.agent.sha256 && params.agent.sha256.toLowerCase() !== actualHash) {
      throw new Error('Package sha256 mismatch');
    }

    const entries = await extractZip(zipPath, extractDir);
    const globalFiles = entries.filter((entry) => entry.section === 'global').map((entry) => entry.relativePath);
    const projectFiles = entries.filter((entry) => entry.section === 'project').map((entry) => entry.relativePath);
    const globalTarget = this.globalTargetForCliType(params.cliType);
    const globalConfigDir = this.globalConfigDirForCliType(params.cliType);
    const copiedGlobalFiles = await copyManagedSection(extractDir, 'global', globalConfigDir, params.agent.version);
    await this.replaceRuntimePlaceholdersInFiles(globalConfigDir, copiedGlobalFiles, params.access);

    const nextManifest: HTHPackageManifest = {
      packageId: params.packageId,
      assistantId: params.assistantId,
      cliType: params.cliType,
      globalTarget,
      artifactKey: params.agent.artifact_key,
      sourceUrl: params.agent.url,
      sourceUrlExpiresAt: params.agent.url_expires_at,
      version: params.agent.version,
      sha256: params.agent.sha256 || actualHash,
      size: params.agent.size,
      name: params.agent.name,
      syncedAt: Date.now(),
      extractDir,
      globalFiles,
      projectFiles,
    };
    const changed =
      !manifest || !this.isPackageManifestCurrent(manifest, { ...params.agent, sha256: nextManifest.sha256 });
    await this.packageStore.writeManifest(nextManifest);
    return { manifest: nextManifest, changed, existing: Boolean(manifest) };
  }

  private globalTargetForCliType(cliType: HTHCliType): 'opencode' | 'codex' {
    return cliType;
  }

  private globalConfigDirForCliType(cliType: HTHCliType): string {
    if (cliType === 'codex') {
      return this.codexHomeDir();
    }
    return this.openCodeConfigDir();
  }

  private codexHomeDir(): string {
    return this.resolveCodexHomeDir();
  }

  private openCodeConfigDir(): string {
    return this.resolveOpenCodeConfigDir();
  }

  private packageResultStatus(outcome: PackageSyncOutcome): HTHSyncPackageResult['status'] {
    if (!outcome.changed) {
      return 'skipped';
    }
    return outcome.existing ? 'updated' : 'synced';
  }

  private isPackageManifestCurrent(manifest: HTHPackageManifest, agent: HTHAgentConfigItem): boolean {
    const expectedArtifactKey = agent.artifact_key || agent.url;
    return (
      manifest.artifactKey === expectedArtifactKey &&
      manifest.version === agent.version &&
      Boolean(agent.sha256) &&
      manifest.sha256 === agent.sha256
    );
  }

  private async writePackageZip(agent: HTHAgentConfigItem, zipPath: string): Promise<void> {
    if (String(agent.url_type) !== 'https') {
      throw new Error(`Unsupported url_type: ${agent.url_type}`);
    }
    if (agent.size !== undefined && agent.size > MAX_AGENT_PACKAGE_BYTES) {
      throw new Error('Package exceeds allowed size limits');
    }
    const response = await fetch(agent.url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > MAX_AGENT_PACKAGE_BYTES) {
      throw new Error('Package exceeds allowed size limits');
    }
    if (agent.size !== undefined && agent.size !== data.byteLength) {
      throw new Error('Package size mismatch');
    }
    await fs.writeFile(zipPath, data);
  }

  private async calculateSha256(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    return createHash('sha256').update(buffer).digest('hex');
  }

  private async resolveManagedAgentIds(): Promise<Map<HTHCliType, string | undefined>> {
    const port = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
    if (!port) {
      return new Map();
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/agents/management`);
    if (!response.ok) {
      return new Map();
    }
    const parsed = (await response.json()) as ApiEnvelope<ManagedAgentRow[]> | ManagedAgentRow[];
    const rows = Array.isArray(parsed) ? parsed : (parsed.data ?? []);
    return new Map<HTHCliType, string | undefined>(
      (Object.keys(MANAGED_AGENT_MATCH) as HTHCliType[]).map((cliType) => [
        cliType,
        this.findManagedAgentId(rows, MANAGED_AGENT_MATCH[cliType]),
      ])
    );
  }

  private findManagedAgentId(rows: ManagedAgentRow[], matchText: string): string | undefined {
    const match = rows.find((agent) => {
      const fields = [agent.id, agent.name, agent.backend, agent.agent_type].filter(Boolean).join(' ').toLowerCase();
      return fields.includes(matchText) && agent.enabled !== false;
    });
    return match?.id;
  }

  private mapAssistant(
    agent: HTHAgentConfigItem,
    assistantId: string,
    agentId: string | undefined,
    avatar: string | undefined
  ): CreateAssistantRequest {
    return {
      id: assistantId,
      name: agent.name,
      description: agent.description,
      categories: agent.categories ?? [],
      avatar,
      agent_id: agentId,
      enabled_skills: [],
      custom_skill_names: [],
      disabled_builtin_skills: [],
      recommended_prompts: agent.recommended_prompts ?? [],
      models: [],
    };
  }

  private async prepareAssistantAvatar(
    avatar: string | undefined,
    assistantId: string
  ): Promise<PreparedAssistantAvatar> {
    const value = avatar?.trim();
    if (!value) {
      return {};
    }
    if (!this.isRemoteImageAvatar(value)) {
      return { value };
    }
    const response = await fetch(value);
    if (!response.ok) {
      throw new Error(`Avatar download failed: ${response.status}`);
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength <= 0 || data.byteLength > MAX_ASSISTANT_AVATAR_BYTES) {
      throw new Error('Avatar exceeds allowed size limits');
    }
    const ext = this.avatarExtension(value, contentType);
    if (!ext) {
      throw new Error('Unsupported avatar image type');
    }
    const sha = createHash('sha256').update(data).digest('hex');
    const dir = path.join(getSystemDir().workDir, ASSISTANT_AVATAR_DIR_NAME);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${this.safeAvatarFileName(assistantId)}-${sha.slice(0, 16)}${ext}`);
    await fs.writeFile(filePath, data);
    return { value: filePath, sha256: sha };
  }

  private isRemoteImageAvatar(value: string): boolean {
    return value.startsWith('http://') || value.startsWith('https://');
  }

  private avatarExtension(value: string, contentType: string): string | null {
    switch (contentType) {
      case 'image/png':
        return '.png';
      case 'image/jpeg':
        return '.jpg';
      case 'image/gif':
        return '.gif';
      case 'image/webp':
        return '.webp';
      default:
        break;
    }
    try {
      const ext = path.extname(new URL(value).pathname).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
        return ext === '.jpeg' ? '.jpg' : ext;
      }
    } catch {
      return null;
    }
    return null;
  }

  private safeAvatarFileName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'assistant';
  }

  private async importAssistants(assistants: CreateAssistantRequest[]): Promise<ImportAssistantsResult> {
    const port = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
    if (!port) {
      throw new Error('aioncore is not running');
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/assistants/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistants }),
    });
    const parsed = (await response.json()) as ApiEnvelope<ImportAssistantsResult> | ImportAssistantsResult;
    if (!response.ok) {
      const envelope = parsed as ApiEnvelope<ImportAssistantsResult>;
      throw new Error(envelope.error || envelope.msg || `Assistant import failed: ${response.status}`);
    }
    if ('data' in parsed && parsed.data) {
      return parsed.data;
    }
    return parsed as ImportAssistantsResult;
  }

  private async updateAssistants(
    assistants: CreateAssistantRequest[],
    existingAssistants: Map<string, Assistant>,
    unchangedRemoteAvatarIds: Set<string>
  ): Promise<AssistantWriteResult> {
    const port = this.requireBackendPort();
    const existingAssistantUpdates = assistants
      .map((assistant) => this.mapAssistantUpdate(assistant))
      .filter((assistant) => {
        const existing = existingAssistants.get(assistant.id);
        return (
          (!existing &&
            ((assistant.categories?.length ?? 0) > 0 || (assistant.recommended_prompts?.length ?? 0) > 0)) ||
          (existing && this.hasAssistantUpdate(existing, assistant, unchangedRemoteAvatarIds.has(assistant.id)))
        );
      });

    const results = await Promise.allSettled(
      existingAssistantUpdates.map((assistant) => this.updateAssistant(port, assistant))
    );
    const failed = results.filter((result) => result.status === 'rejected').length;
    const skipped = assistants.filter((assistant) => {
      const id = assistant.id || '';
      const existing = existingAssistants.get(id);
      return (
        existing &&
        !this.hasAssistantUpdate(existing, this.mapAssistantUpdate(assistant), unchangedRemoteAvatarIds.has(id))
      );
    }).length;
    return {
      updated: existingAssistantUpdates.length - failed,
      deleted: 0,
      skipped,
      failed,
    };
  }

  private async persistAssistantCategories(assistants: CreateAssistantRequest[]): Promise<void> {
    const port = this.requireBackendPort();
    const categories = Object.fromEntries(
      assistants.map((assistant) => [assistant.id || '', assistant.categories ?? []]).filter(([id]) => Boolean(id))
    );
    const response = await fetch(`http://127.0.0.1:${port}/api/settings/client`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [HTH_ASSISTANT_CATEGORIES_SETTING]: categories }),
    });
    if (!response.ok) {
      throw new Error(await this.extractBackendError(response, `Assistant categories save failed: ${response.status}`));
    }
  }

  private async updateAssistant(port: number, assistant: UpdateAssistantRequest): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${port}/api/assistants/${encodeURIComponent(assistant.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(assistant),
    });
    if (!response.ok) {
      throw new Error(await this.extractBackendError(response, `Assistant update failed: ${response.status}`));
    }
  }

  private mapAssistantUpdate(assistant: CreateAssistantRequest): UpdateAssistantRequest {
    return {
      id: assistant.id || '',
      name: assistant.name,
      description: assistant.description,
      categories: assistant.categories,
      avatar: assistant.avatar,
      agent_id: assistant.agent_id,
      recommended_prompts: assistant.recommended_prompts,
    };
  }

  private hasAssistantUpdate(
    existing: Assistant,
    assistant: UpdateAssistantRequest,
    remoteAvatarUnchanged: boolean
  ): boolean {
    return (
      existing.name !== assistant.name ||
      (existing.description ?? '') !== (assistant.description ?? '') ||
      !this.sameStringArray(existing.categories, assistant.categories) ||
      !this.sameStringArray(existing.prompts, assistant.recommended_prompts) ||
      !this.sameAssistantAvatar(existing, assistant, remoteAvatarUnchanged) ||
      (assistant.agent_id !== undefined && existing.agent_id !== assistant.agent_id)
    );
  }

  private sameStringArray(existing: string[] | undefined, next: string[] | undefined): boolean {
    const existingValues = existing ?? [];
    const nextValues = next ?? [];
    return (
      existingValues.length === nextValues.length && existingValues.every((value, index) => value === nextValues[index])
    );
  }

  private sameAssistantAvatar(
    existing: Assistant,
    assistant: UpdateAssistantRequest,
    remoteAvatarUnchanged: boolean
  ): boolean {
    const existingAvatar = existing.avatar ?? '';
    const nextAvatar = assistant.avatar ?? '';
    if (existingAvatar === nextAvatar) {
      return true;
    }
    if (!remoteAvatarUnchanged || !nextAvatar.includes(ASSISTANT_AVATAR_DIR_NAME)) {
      return false;
    }
    const escapedId = encodeURIComponent(assistant.id);
    return existingAvatar === `/api/assistants/${escapedId}/avatar`;
  }

  private async deleteRevokedAssistants(currentAssistantIds: Set<string>): Promise<AssistantWriteResult> {
    const port = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
    if (!port) {
      throw new Error('aioncore is not running');
    }

    const manifests = await this.packageStore.readAllManifests();
    const revokedAssistantIds = Array.from(new Set(manifests.map((manifest) => manifest.assistantId))).filter(
      (assistantId) => !currentAssistantIds.has(assistantId)
    );
    if (revokedAssistantIds.length === 0) {
      return this.emptyAssistantWriteResult();
    }

    const existingAssistantIds = await this.listAssistantIds(port);
    const results = await Promise.allSettled(
      revokedAssistantIds.map(async (assistantId) => {
        if (existingAssistantIds.has(assistantId)) {
          await this.deleteAssistant(port, assistantId);
        }
        await this.packageStore.deleteByAssistantId(assistantId);
      })
    );
    const failed = results.filter((result) => result.status === 'rejected').length;
    return {
      updated: 0,
      deleted: revokedAssistantIds.length - failed,
      skipped: 0,
      failed,
    };
  }

  private async listAssistantIds(port: number): Promise<Set<string>> {
    const assistants = await this.fetchAssistants(port);
    return new Set(assistants.map((assistant) => assistant.id));
  }

  private async listAssistants(port: number): Promise<Map<string, Assistant>> {
    const assistants = await this.fetchAssistants(port);
    return new Map(assistants.map((assistant) => [assistant.id, assistant]));
  }

  private async fetchAssistants(port: number): Promise<Assistant[]> {
    const response = await fetch(`http://127.0.0.1:${port}/api/assistants`);
    if (!response.ok) {
      throw new Error(await this.extractBackendError(response, `Assistant list failed: ${response.status}`));
    }
    const parsed = (await response.json()) as ApiEnvelope<Assistant[]> | Assistant[];
    return Array.isArray(parsed) ? parsed : (parsed.data ?? []);
  }

  private requireBackendPort(): number {
    const port = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
    if (!port) {
      throw new Error('aioncore is not running');
    }
    return port;
  }

  private async deleteAssistant(port: number, assistantId: string): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${port}/api/assistants/${encodeURIComponent(assistantId)}`, {
      method: 'DELETE',
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(await this.extractBackendError(response, `Assistant delete failed: ${response.status}`));
    }
  }

  private async extractBackendError(response: Response, fallback: string): Promise<string> {
    try {
      const parsed = (await response.json()) as ApiEnvelope<unknown>;
      return parsed.error || parsed.msg || fallback;
    } catch {
      return fallback;
    }
  }

  private emptyImportResult(): ImportAssistantsResult {
    return {
      imported: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };
  }

  private emptyAssistantWriteResult(): AssistantWriteResult {
    return {
      updated: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
    };
  }
}
