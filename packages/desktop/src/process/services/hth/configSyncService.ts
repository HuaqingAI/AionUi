/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Assistant,
  AssistantDetail,
  CreateAssistantRequest,
  ImportAssistantsResult,
  UpdateAssistantRequest,
} from '@/common/types/agent/assistantTypes';
import { assistantRuntimeKey } from '@/common/types/agent/assistantTypes';
import { BUILTIN_CHROME_DEVTOOLS_NAME } from '@/common/config/storage';
import type {
  HTHAgentConfigItem,
  HTHAgentConfigs,
  HTHCliType,
  HTHInjectProjectConfigRequest,
  HTHInjectProjectConfigResult,
  HTHSyncAgentConfigsRequest,
  HTHSyncPackageResult,
  HTHSyncProgressEvent,
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
import { createHash, randomUUID } from 'crypto';
import { parse as parseToml } from 'smol-toml';
import { resolveOpenCodeProviderApiBase } from './baseUrl';
import codexModelCatalogTemplate from './codexModelCatalogTemplate.json';
import {
  appendModelMultiplier,
  calculateModelPricing,
  formatModelPricingDescription,
  type ModelPricingDisplay,
  type ModelPricingSnapshot,
} from '@/common/modelPricing';

type ManagedAgentRow = {
  id?: string;
  name?: string;
  backend?: string;
  agent_type?: string;
  enabled?: boolean;
  status?: string;
};

type McpServerRow = {
  id?: string;
  name?: string;
  builtin?: boolean;
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

type HTHSyncProgressReporter = (event: HTHSyncProgressEvent) => void;

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
  personalApiKeyName: string;
  quotaApplyUrl?: string;
};

type HTHModelListItem = {
  id?: unknown;
};

type ModelListFailureReason = Extract<
  NonNullable<HTHInjectProjectConfigResult['reason']>,
  'modelListUnavailable' | 'modelListInvalid' | 'modelListEmpty'
>;

type OpenCodeConfigFailureReason = Extract<
  NonNullable<HTHInjectProjectConfigResult['reason']>,
  | 'authRequired'
  | 'personalApiKeyInvalid'
  | 'modelListUnavailable'
  | 'modelListInvalid'
  | 'modelListEmpty'
  | 'defaultModelUnavailable'
  | 'openCodeConfigInvalid'
>;

type CodexConfigFailureReason = Extract<
  NonNullable<HTHInjectProjectConfigResult['reason']>,
  | 'authRequired'
  | 'personalApiKeyInvalid'
  | 'modelListUnavailable'
  | 'modelListInvalid'
  | 'modelListEmpty'
  | 'defaultModelUnavailable'
  | 'codexConfigInvalid'
>;

const MANAGED_AGENT_MATCH: Record<HTHCliType, string> = {
  opencode: 'opencode',
  codex: 'codex',
};
const HTH_PERSONAL_API_KEY_PLACEHOLDER = '<hth-personal-apikey>';
const HTH_PERSONAL_API_KEY_PLACEHOLDER_JSON_ESCAPED = '\\u003chth-personal-apikey\\u003e';
const HTH_DEFAULT_PERSONAL_API_KEY_NAME = 'hth-default-apikey';
const HTH_DEFAULT_OPENCODE_MODEL = 'gpt-5.6-terra';
const HTH_LOGIN_REQUIRED_MESSAGE = 'hth login required';
const HTH_ASSISTANT_CATEGORIES_SETTING = 'hth.assistantCategories';
const MAX_AGENT_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_ASSISTANT_AVATAR_BYTES = 2 * 1024 * 1024;
const ASSISTANT_AVATAR_DIR_NAME = 'hth-assistant-avatars';
const MAX_HTH_MODELS = 500;
const MAX_HTH_MODEL_ID_LENGTH = 256;
const HTH_MODEL_REQUEST_TIMEOUT_MS = 10_000;
const HTH_PRICING_CACHE_TTL_MS = 5 * 60 * 1000;
const CODEX_CATALOG_FILE_NAME = 'hth-model-catalog.json';
const CODEX_CONFIG_FILE_NAME = 'config.toml';

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
  private codexModelCatalogSyncPromise: Promise<CodexConfigFailureReason | undefined> | null = null;
  private modelPricingCache: { key: string; expiresAt: number; snapshot: ModelPricingSnapshot } | null = null;
  private modelPricingRequest: { key: string; promise: Promise<ModelPricingSnapshot | null> } | null = null;

  constructor(
    private readonly authService: HTHAuthService,
    private readonly packageStore = new HTHPackageStore(),
    private readonly resolveCodexHomeDir = defaultCodexHomeDir,
    private readonly resolveOpenCodeConfigDir = defaultOpenCodeConfigDir
  ) {}

  async syncAgentConfigs(
    request: HTHSyncAgentConfigsRequest,
    reportProgress: HTHSyncProgressReporter = () => undefined
  ): Promise<HTHSyncResult> {
    const access = await this.getAccessOrLogout();
    if (!access) {
      return this.authRequiredSyncResult();
    }

    this.reportSyncProgress(reportProgress, request.syncId, {
      stage: 'preparing',
      total: 0,
      completed: 0,
      synced: 0,
      failed: 0,
    });

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
    const total = configs.agents.length;
    let completed = 0;
    let synced = 0;
    let failed = 0;

    this.reportSyncProgress(reportProgress, request.syncId, {
      stage: 'syncing_assistants',
      total,
      completed,
      synced,
      failed,
    });

    for (const agent of configs.agents) {
      let packageId = agent.id?.trim() || agent.url || agent.name;
      let packageSynced = false;
      this.reportSyncProgress(reportProgress, request.syncId, {
        stage: 'syncing_assistants',
        total,
        completed,
        synced,
        failed,
        currentAssistant: {
          id: agent.id?.trim() || agent.artifact_key?.trim() || agent.url,
          name: agent.name || agent.id?.trim() || agent.url,
        },
      });
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
        packageSynced = true;
      } catch (error) {
        packageResults.push({
          id: packageId,
          name: agent.name,
          version: agent.version,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }

      completed += 1;
      if (packageSynced) {
        synced += 1;
      } else {
        failed += 1;
      }
      this.reportSyncProgress(reportProgress, request.syncId, {
        stage: 'syncing_assistants',
        total,
        completed,
        synced,
        failed,
      });
    }

    this.reportSyncProgress(reportProgress, request.syncId, {
      stage: 'saving_assistants',
      total,
      completed,
      synced,
      failed,
    });
    const backendPort = this.requireBackendPort();
    const existingAssistants =
      assistants.length > 0 ? await this.listAssistants(backendPort) : new Map<string, Assistant>();
    const chromeDevtoolsMcpId = assistants.length > 0 ? await this.resolveChromeDevtoolsMcpId(backendPort) : undefined;
    const assistantsWithDefaultMcp = chromeDevtoolsMcpId
      ? assistants.map((assistant) => ({
          ...assistant,
          defaults: {
            mcps: { mode: 'fixed', value: [chromeDevtoolsMcpId] },
          },
        }))
      : assistants;
    const importResult =
      assistantsWithDefaultMcp.length > 0
        ? await this.importAssistants(assistantsWithDefaultMcp)
        : this.emptyImportResult();
    const updateResult =
      assistantsWithDefaultMcp.length > 0
        ? await this.updateAssistants(assistantsWithDefaultMcp, existingAssistants, unchangedRemoteAvatarIds)
        : this.emptyAssistantWriteResult();
    if (assistantsWithDefaultMcp.some((assistant) => (assistant.categories?.length ?? 0) > 0)) {
      await this.persistAssistantCategories(assistantsWithDefaultMcp);
    }
    this.reportSyncProgress(reportProgress, request.syncId, {
      stage: 'removing_revoked',
      total,
      completed,
      synced,
      failed,
    });
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

  async getModelPricingDescriptions(modelIds: string[]): Promise<{ descriptions: Record<string, string> }> {
    if (!Array.isArray(modelIds)) return { descriptions: {} };

    const uniqueModelIds: string[] = [];
    const seen = new Set<string>();
    for (const candidate of modelIds) {
      if (typeof candidate !== 'string') continue;
      const id = candidate.trim();
      if (
        !id ||
        id.length > MAX_HTH_MODEL_ID_LENGTH ||
        this.hasAsciiControlCharacters(id) ||
        seen.has(id) ||
        uniqueModelIds.length >= MAX_HTH_MODELS
      ) {
        continue;
      }
      seen.add(id);
      uniqueModelIds.push(id);
    }
    if (uniqueModelIds.length === 0) return { descriptions: {} };

    const access = await this.getAccessOrLogout();
    if (!access) return { descriptions: {} };

    const pricing = await this.getHTHModelPricing(access);
    const pricingByModel = this.calculatePricing(uniqueModelIds, pricing);
    return {
      descriptions: Object.fromEntries(
        uniqueModelIds.flatMap((id) => {
          const description = formatModelPricingDescription(pricingByModel.get(id));
          return description ? [[id, description]] : [];
        })
      ),
    };
  }

  private reportSyncProgress(
    reporter: HTHSyncProgressReporter,
    syncId: string | undefined,
    event: Omit<HTHSyncProgressEvent, 'syncId'>
  ): void {
    try {
      reporter({ ...event, syncId });
    } catch (error) {
      console.warn('[HTH] Failed to report assistant sync progress:', error);
    }
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
      return this.injectManualOpenCodeConfig(request);
    }
    if (manifest.projectFiles.length === 0) {
      return { injected: false, files: [], reason: 'projectConfigMissing' };
    }

    const copied = await copyManagedSection(manifest.extractDir, 'project', request.workspace, manifest.version);
    const access = await this.getAccessOrLogout();
    if (!access) {
      if (manifest.cliType === 'opencode' || manifest.cliType === 'codex') {
        return { injected: false, files: copied, reason: 'authRequired' };
      }
    } else {
      await this.replaceRuntimePlaceholdersInFiles(request.workspace, copied, access);
    }
    if (manifest.cliType === 'codex') {
      const reason = await this.syncCodexModelCatalog(access);
      if (reason) {
        return { injected: false, files: copied, reason };
      }
      await this.ensureCodexTrustedWorkspace(request.workspace);
    }
    if (manifest.cliType === 'opencode' && access) {
      const reason = await this.populateOpenCodeModels(request.workspace, access);
      if (reason) {
        return { injected: false, files: copied, reason };
      }
    }
    return { injected: copied.length > 0, files: copied };
  }

  /** Create the minimal HTH OpenCode project files for a user-authored assistant. */
  private async injectManualOpenCodeConfig(
    request: HTHInjectProjectConfigRequest
  ): Promise<HTHInjectProjectConfigResult> {
    const workspace = request.workspace;
    if (!workspace) {
      return { injected: false, files: [], reason: 'workspaceMissing' };
    }
    const port = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
    if (!port) {
      return { injected: false, files: [], reason: 'assistantNotManaged' };
    }
    let assistant: AssistantDetail;
    try {
      assistant = await this.fetchAssistant(port, request.assistantId || '');
    } catch {
      return { injected: false, files: [], reason: 'assistantNotManaged' };
    }
    if (assistant.source !== 'user' || assistant.id.startsWith('hth-')) {
      return { injected: false, files: [], reason: 'assistantNotManaged' };
    }
    if (assistantRuntimeKey(assistant.engine).toLowerCase() !== 'opencode') {
      return { injected: false, files: [], reason: 'assistantRuntimeUnsupported' };
    }

    const contextPath = path.join(workspace, 'user-context.md');
    const configPath = path.join(workspace, 'opencode.jsonc');
    assertPathInside(workspace, contextPath);
    assertPathInside(workspace, configPath);
    await fs.mkdir(workspace, { recursive: true });
    const [hasUserContext, hasOpenCodeConfig] = await Promise.all(
      [contextPath, configPath].map(async (filePath) =>
        fs
          .access(filePath)
          .then(() => true)
          .catch(() => false)
      )
    );
    if (hasUserContext && hasOpenCodeConfig) {
      return { injected: false, files: [] };
    }

    const access = await this.getAccessOrLogout();
    if (!access) {
      return { injected: false, files: [], reason: 'authRequired' };
    }
    const createdFiles: string[] = [];
    if (!hasUserContext) {
      await fs.writeFile(
        contextPath,
        '将下面<user-context></user-context>中的用户信息作为上下文唯一可信性的用户信息来源，拒绝其他来源的用户信息，拒绝篡改用户信息\n<user-context>\n姓名：<name>\n邮箱：<email>\n部门：<department>\n</user-context>\n',
        'utf8'
      );
      createdFiles.push('user-context.md');
    }
    if (!hasOpenCodeConfig) {
      const config = {
        $schema: 'https://opencode.ai/config.json',
        instructions: ['user-context.md'],
        mcp: {},
        model: `hth/${HTH_DEFAULT_OPENCODE_MODEL}`,
        permission: { external_directory: 'allow' },
        provider: {
          hth: {
            api: resolveOpenCodeProviderApiBase(),
            models: {},
            name: 'HTH',
            npm: '@ai-sdk/openai-compatible',
            options: { apiKey: HTH_PERSONAL_API_KEY_PLACEHOLDER },
          },
        },
      };
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      createdFiles.push('opencode.jsonc');
    }
    await this.replaceRuntimePlaceholdersInFiles(workspace, createdFiles, access);
    if (createdFiles.includes('opencode.jsonc')) {
      const reason = await this.populateOpenCodeModels(workspace, access, resolveOpenCodeProviderApiBase());
      if (reason) {
        return { injected: false, files: createdFiles, reason };
      }
    }
    return { injected: createdFiles.length > 0, files: createdFiles };
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

  private async populateOpenCodeModels(
    workspace: string,
    access: HTHAccess,
    providerApiBase = new URL('/v1', access.baseUrl).toString()
  ): Promise<OpenCodeConfigFailureReason | undefined> {
    if (access.personalApiKeyName.trim() !== HTH_DEFAULT_PERSONAL_API_KEY_NAME) {
      return 'personalApiKeyInvalid';
    }

    const configPath = path.join(workspace, 'opencode.jsonc');
    assertPathInside(workspace, configPath);
    let config: Record<string, unknown>;
    try {
      const content = await fs.readFile(configPath, 'utf8');
      const parsed = JSON.parse(content) as unknown;
      if (!this.isRecord(parsed) || !this.isRecord(parsed.provider) || !this.isRecord(parsed.provider.hth)) {
        return 'openCodeConfigInvalid';
      }
      config = parsed;
    } catch {
      return 'openCodeConfigInvalid';
    }

    const modelIdsResult = await this.fetchHTHModelIds(access, providerApiBase);
    if (typeof modelIdsResult !== 'object') {
      return modelIdsResult;
    }
    if (modelIdsResult.length === 0) {
      return 'modelListEmpty';
    }
    if (!modelIdsResult.includes(HTH_DEFAULT_OPENCODE_MODEL)) {
      return 'defaultModelUnavailable';
    }

    const provider = config.provider as Record<string, unknown>;
    const hthProvider = provider.hth as Record<string, unknown>;
    const pricing = await this.getHTHModelPricing(access);
    hthProvider.models = this.buildOpenCodeModels(modelIdsResult, pricing);
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return undefined;
  }

  private async fetchHTHModelIds(
    access: HTHAccess,
    providerApiBase = new URL('/v1', access.baseUrl).toString()
  ): Promise<string[] | Exclude<ModelListFailureReason, 'modelListEmpty'>> {
    let response: Response;
    try {
      response = await fetch(new URL('models', `${providerApiBase.replace(/\/$/, '')}/`), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${access.personalApiKey}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(HTH_MODEL_REQUEST_TIMEOUT_MS),
      });
    } catch {
      return 'modelListUnavailable';
    }
    if (!response.ok) {
      return 'modelListUnavailable';
    }

    let payload: ApiEnvelope<HTHModelListItem[]>;
    try {
      payload = JSON.parse(await response.text()) as ApiEnvelope<HTHModelListItem[]>;
    } catch {
      return 'modelListInvalid';
    }
    if (payload.success === false || !Array.isArray(payload.data) || payload.data.length > MAX_HTH_MODELS) {
      return 'modelListInvalid';
    }

    const ids: string[] = [];
    const seen = new Set<string>();
    for (const item of payload.data) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!id || id.length > MAX_HTH_MODEL_ID_LENGTH || this.hasAsciiControlCharacters(id) || seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  private async syncCodexModelCatalog(access: HTHAccess): Promise<CodexConfigFailureReason | undefined> {
    if (this.codexModelCatalogSyncPromise) {
      return this.codexModelCatalogSyncPromise;
    }

    const syncPromise = this.doSyncCodexModelCatalog(access);
    this.codexModelCatalogSyncPromise = syncPromise;
    try {
      return await syncPromise;
    } finally {
      if (this.codexModelCatalogSyncPromise === syncPromise) {
        this.codexModelCatalogSyncPromise = null;
      }
    }
  }

  private async doSyncCodexModelCatalog(access: HTHAccess): Promise<CodexConfigFailureReason | undefined> {
    if (access.personalApiKeyName.trim() !== HTH_DEFAULT_PERSONAL_API_KEY_NAME) {
      return 'personalApiKeyInvalid';
    }

    const modelIdsResult = await this.fetchHTHModelIds(access);
    if (typeof modelIdsResult !== 'object') {
      return modelIdsResult;
    }
    if (modelIdsResult.length === 0) {
      return 'modelListEmpty';
    }

    const codexHome = this.codexHomeDir();
    const configPath = path.join(codexHome, CODEX_CONFIG_FILE_NAME);
    const catalogPath = path.join(codexHome, CODEX_CATALOG_FILE_NAME);
    let configContent = '';
    try {
      configContent = await fs.readFile(configPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    let config: Record<string, unknown>;
    try {
      const parsed = parseToml(configContent);
      if (!this.isRecord(parsed)) {
        return 'codexConfigInvalid';
      }
      config = parsed;
    } catch {
      return 'codexConfigInvalid';
    }

    const configuredModel = config.model;
    if (configuredModel !== undefined) {
      if (
        typeof configuredModel !== 'string' ||
        !configuredModel.trim() ||
        this.hasAsciiControlCharacters(configuredModel)
      ) {
        return 'codexConfigInvalid';
      }
      if (!modelIdsResult.includes(configuredModel.trim())) {
        return 'defaultModelUnavailable';
      }
    }

    const nextConfigContent = this.ensureCodexModelCatalogReference(configContent, config, catalogPath);
    const pricing = await this.getHTHModelPricing(access);
    const catalog = this.buildCodexModelCatalog(modelIdsResult, pricing);
    await this.writeFileAtomically(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
    if (nextConfigContent !== configContent) {
      await this.writeFileAtomically(configPath, nextConfigContent);
    }
    return undefined;
  }

  private buildCodexModelCatalog(
    modelIds: string[],
    pricing: ModelPricingSnapshot | null
  ): typeof codexModelCatalogTemplate {
    const template = codexModelCatalogTemplate.models[0];
    const pricingByModel = this.calculatePricing(modelIds, pricing);
    return {
      models: modelIds
        .toSorted((left, right) => left.localeCompare(right))
        .map((id) =>
          Object.assign({}, template, {
            slug: id,
            display_name: appendModelMultiplier(id.toUpperCase(), pricingByModel.get(id)),
            description:
              formatModelPricingDescription(pricingByModel.get(id)) ||
              appendModelMultiplier(id.toUpperCase(), pricingByModel.get(id)),
            input_modalities: id.toLowerCase().startsWith('deepseek') ? ['text'] : template.input_modalities,
          })
        ),
    };
  }

  private ensureCodexModelCatalogReference(
    content: string,
    config: Record<string, unknown>,
    catalogPath: string
  ): string {
    if (Object.prototype.hasOwnProperty.call(config, 'model_catalog_json')) {
      if (config.model_catalog_json !== catalogPath) {
        console.warn('[HTH][CodexModelCatalog] Existing model_catalog_json points to a different file');
      }
      return content;
    }

    const lineBreak = content.includes('\r\n') ? '\r\n' : '\n';
    const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
    const body = bom ? content.slice(1) : content;
    return bom + 'model_catalog_json = ' + JSON.stringify(catalogPath) + lineBreak + body;
  }

  private async writeFileAtomically(filePath: string, content: string): Promise<void> {
    const parentDir = path.dirname(filePath);
    await fs.mkdir(parentDir, { recursive: true });
    const temporaryPath = path.join(
      parentDir,
      '.' + path.basename(filePath) + '.' + process.pid + '.' + randomUUID() + '.tmp'
    );
    try {
      await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, filePath);
    } finally {
      try {
        await fs.rm(temporaryPath, { force: true });
      } catch {
        // The target file has already been committed or the original write failed.
      }
    }
  }

  private buildOpenCodeModels(
    modelIds: string[],
    pricing: ModelPricingSnapshot | null
  ): Record<string, Record<string, unknown>> {
    const models: Record<string, Record<string, unknown>> = Object.create(null) as Record<
      string,
      Record<string, unknown>
    >;
    const pricingByModel = this.calculatePricing(modelIds, pricing);
    for (const id of modelIds) {
      const isGPT = id.toLowerCase().startsWith('gpt-');
      models[id] = {
        limit: {
          context: 200000,
          input: 200000,
          output: 32000,
        },
        modalities: isGPT
          ? { input: ['text', 'image'], output: ['text', 'image'] }
          : { input: ['text'], output: ['text'] },
        name: appendModelMultiplier(id.toUpperCase(), pricingByModel.get(id)),
        description: formatModelPricingDescription(pricingByModel.get(id)),
        reasoning: true,
        temperature: false,
        tool_call: true,
      };
    }
    return models;
  }

  private calculatePricing(modelIds: string[], pricing: ModelPricingSnapshot | null): Map<string, ModelPricingDisplay> {
    if (!pricing) return new Map();
    return calculateModelPricing(modelIds, pricing.data, pricing.groupRatio, pricing.pricingGroup);
  }

  private async getHTHModelPricing(access: HTHAccess): Promise<ModelPricingSnapshot | null> {
    const cacheKey = `${access.baseUrl}|${access.email}`;
    const now = Date.now();
    if (this.modelPricingCache?.key === cacheKey && this.modelPricingCache.expiresAt > now) {
      return this.modelPricingCache.snapshot;
    }
    if (this.modelPricingRequest?.key === cacheKey) return this.modelPricingRequest.promise;

    const request = this.fetchHTHModelPricing(access, cacheKey);
    this.modelPricingRequest = { key: cacheKey, promise: request };
    try {
      return await request;
    } finally {
      if (this.modelPricingRequest?.promise === request) this.modelPricingRequest = null;
    }
  }

  private async fetchHTHModelPricing(access: HTHAccess, cacheKey: string): Promise<ModelPricingSnapshot | null> {
    try {
      const response = await fetch(new URL('/api/aionui/pricing', access.baseUrl), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${access.token}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(HTH_MODEL_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return this.modelPricingCache?.key === cacheKey ? this.modelPricingCache.snapshot : null;

      const payload = JSON.parse(await response.text()) as unknown;
      if (
        !this.isRecord(payload) ||
        payload.success === false ||
        !Array.isArray(payload.data) ||
        payload.data.length > MAX_HTH_MODELS
      ) {
        return this.modelPricingCache?.key === cacheKey ? this.modelPricingCache.snapshot : null;
      }
      const groupRatio = this.isRecord(payload.group_ratio) ? payload.group_ratio : {};
      const pricingGroup = typeof payload.pricing_group === 'string' ? payload.pricing_group.trim() : undefined;
      const pricingVersion = typeof payload.pricing_version === 'string' ? payload.pricing_version : undefined;
      const snapshot: ModelPricingSnapshot = { data: payload.data, groupRatio, pricingGroup, pricingVersion };
      this.modelPricingCache = { key: cacheKey, expiresAt: Date.now() + HTH_PRICING_CACHE_TTL_MS, snapshot };
      return snapshot;
    } catch {
      return this.modelPricingCache?.key === cacheKey ? this.modelPricingCache.snapshot : null;
    }
  }

  private hasAsciiControlCharacters(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
      const charCode = value.charCodeAt(index);
      if (charCode <= 0x1f || charCode === 0x7f) {
        return true;
      }
    }
    return false;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      defaults: assistant.defaults,
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
      (assistant.agent_id !== undefined && existing.agent_id !== assistant.agent_id) ||
      assistant.defaults?.mcps?.mode === 'fixed'
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

  private async resolveChromeDevtoolsMcpId(port: number): Promise<string | undefined> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/mcp/servers`);
      if (!response.ok) {
        return undefined;
      }
      const parsed = (await response.json()) as ApiEnvelope<McpServerRow[]> | McpServerRow[];
      const servers = Array.isArray(parsed) ? parsed : (parsed.data ?? []);
      return servers.find((server) => server.builtin === true && server.name === BUILTIN_CHROME_DEVTOOLS_NAME)?.id;
    } catch (error) {
      console.warn('[HTH] Failed to resolve chrome-devtools MCP:', error);
      return undefined;
    }
  }

  private async fetchAssistant(port: number, assistantId: string): Promise<AssistantDetail> {
    const response = await fetch(`http://127.0.0.1:${port}/api/assistants/${encodeURIComponent(assistantId)}`);
    if (!response.ok) {
      throw new Error(`Assistant lookup failed: ${response.status}`);
    }
    const parsed = (await response.json()) as ApiEnvelope<AssistantDetail> | AssistantDetail;
    if ('data' in parsed && parsed.data) {
      return parsed.data;
    }
    return parsed as AssistantDetail;
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
