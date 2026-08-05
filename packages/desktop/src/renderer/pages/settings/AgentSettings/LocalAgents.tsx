/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IRuntimeStatusEvent, RuntimeFailureKind } from '@/common/adapter/ipcBridge';
import { parseError } from '@/common/utils';
import { formatManagedAgentDiagnosticMessage, type ManagedAgent } from '@/renderer/utils/model/agentTypes';
import AionModal from '@/renderer/components/base/AionModal';
import { AionSearchInput } from '@/renderer/components/base';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { useManagedAgents } from '@/renderer/hooks/agent/useManagedAgents';
import { Alert, Message, Typography } from '@arco-design/web-react';
import TalkToButlerButton from '@/renderer/components/base/TalkToButlerButton';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AgentCard from './AgentCard';
import { isDeprecatedRuntimeAgentType } from '@/renderer/utils/model/agentTypeSupportPolicy';
import InlineAgentEditor, { type CustomAgentDraft } from './InlineAgentEditor';
import { getBoundAssistants, useAssistantsForAgents } from './BoundAssistants';
import SettingsPageHeader from '../components/SettingsPageHeader';
import { useNavigate } from 'react-router-dom';
import {
  filterAgentsByAvailability,
  getAgentAvailabilityFilterStats,
  type AgentAvailabilityFilter,
} from './agentFilters';

type VisibleAgentAvailabilityFilter = Extract<AgentAvailabilityFilter, 'all' | 'available'>;

const VISIBLE_AGENT_TOOL_IDS = new Set(['codex', 'opencode']);
const STARTUP_RUNTIME_TOOL_LABELS: Record<string, string> = {
  codex: 'Codex',
  opencode: 'OpenCode',
};
const STARTUP_RUNTIME_SCOPE_TOOL_IDS: Record<string, string> = {
  'startup-codex': 'codex',
  'startup-opencode': 'opencode',
};

type OpenCodePreparationBanner = {
  type: 'info' | 'success' | 'error';
  message: string;
};

const PREPARATION_ALERT_BASE_CLASS =
  '!rounded-10px !border !border-solid !px-14px !py-10px [&_.arco-alert-content]:!text-13px [&_.arco-alert-content]:!font-500';
const PREPARATION_ALERT_TONE_CLASS: Record<OpenCodePreparationBanner['type'], string> = {
  info: '!border-primary-5 !bg-primary-light-1 !shadow-[0_8px_24px_rgba(var(--primary-6),0.18)] [&_.arco-alert-content]:!text-primary-7 [&_.arco-alert-icon]:!text-primary-6',
  success:
    '!border-success-5 !bg-success-light-1 !shadow-[0_8px_24px_rgba(var(--success-6),0.16)] [&_.arco-alert-content]:!text-success-7 [&_.arco-alert-icon]:!text-success-6',
  error:
    '!border-danger-5 !bg-danger-light-1 !shadow-[0_8px_24px_rgba(var(--danger-6),0.18)] [&_.arco-alert-content]:!text-danger-7 [&_.arco-alert-icon]:!text-danger-6',
};

function resolveStartupRuntimeToolLabel(event: IRuntimeStatusEvent): string | null {
  if (event.scope.kind !== 'custom_agent') {
    return null;
  }
  const resourceToolId = event.resource_id && STARTUP_RUNTIME_TOOL_LABELS[event.resource_id] ? event.resource_id : null;
  const toolId = resourceToolId ?? STARTUP_RUNTIME_SCOPE_TOOL_IDS[event.scope.id];
  return toolId ? (STARTUP_RUNTIME_TOOL_LABELS[toolId] ?? null) : null;
}

function runtimeFailureTranslationKey(kind?: RuntimeFailureKind): string {
  switch (kind) {
    case 'timeout':
      return 'settings.runtimeStatus.failedTimeout';
    case 'download_failed':
      return 'settings.runtimeStatus.failedDownload';
    case 'http_status':
      return 'settings.runtimeStatus.failedHttp';
    case 'checksum_mismatch':
      return 'settings.runtimeStatus.failedChecksum';
    case 'validation_failed':
      return 'settings.runtimeStatus.failedValidation';
    case 'unsupported_platform':
      return 'settings.runtimeStatus.failedUnsupported';
    case 'bundled_resource_missing':
    case 'bundled_resource_invalid':
      return 'settings.runtimeStatus.failedBundled';
    default:
      return 'settings.runtimeStatus.failedUnknown';
  }
}

function isVisibleLocalAgent(agent: ManagedAgent): boolean {
  return VISIBLE_AGENT_TOOL_IDS.has(agent.backend) || VISIBLE_AGENT_TOOL_IDS.has(agent.agent_type);
}

const LocalAgents: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const [testingAgentId, setTestingAgentId] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState<VisibleAgentAvailabilityFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [openCodePreparation, setOpenCodePreparation] = useState<OpenCodePreparationBanner | null>(null);
  const { assistants } = useAssistantsForAgents();

  // `refreshCatalog` also refreshes assistant list caches because
  // generated-assistant availability can change after health checks.
  const { agents: allAgents, isRefreshing, refreshCatalog } = useManagedAgents();

  useEffect(() => {
    const handleRuntimeStatus = (event: IRuntimeStatusEvent) => {
      const resource = resolveStartupRuntimeToolLabel(event);
      if (!resource) {
        return;
      }
      switch (event.phase) {
        case 'waiting_for_lock':
          setOpenCodePreparation({
            type: 'info',
            message: t('settings.runtimeStatus.waitingForLock', { resource }),
          });
          break;
        case 'downloading':
        case 'extracting':
          setOpenCodePreparation({
            type: 'info',
            message: t('settings.runtimeStatus.downloading', { resource }),
          });
          break;
        case 'validating':
          setOpenCodePreparation({
            type: 'info',
            message: t('settings.runtimeStatus.validating', { resource }),
          });
          break;
        case 'ready':
          setOpenCodePreparation({
            type: 'success',
            message: t('settings.runtimeStatus.ready', { resource }),
          });
          break;
        case 'failed':
          setOpenCodePreparation({
            type: 'error',
            message: t(runtimeFailureTranslationKey(event.failure_kind), { resource }),
          });
          break;
      }
    };
    const unsubscribeBackendStatus = ipcBridge.runtime.statusChanged.on(handleRuntimeStatus);
    const unsubscribeLocalStatus = ipcBridge.runtime.localStatusChanged.on(handleRuntimeStatus);
    return () => {
      unsubscribeBackendStatus();
      unsubscribeLocalStatus();
    };
  }, [t]);

  // Hide deprecated runtime backends (nanobot / openclaw-gateway / remote / gemini)
  // They are no longer offered as agents and shouldn't appear on the detection page.
  const officialAgents = allAgents.filter(
    (a) => a.agent_source !== 'custom' && isVisibleLocalAgent(a) && !isDeprecatedRuntimeAgentType(a.agent_type)
  );
  const customAgents: ManagedAgent[] = allAgents.filter((a) => a.agent_source === 'custom');

  const [editorVisible, setEditorVisible] = useState(false);
  const [editingAgent, setEditingAgent] = useState<ManagedAgent | null>(null);

  const handleSaveCustomAgent = useCallback(
    async (draft: CustomAgentDraft) => {
      const body = {
        name: draft.name,
        command: draft.command,
        icon: draft.icon,
        args: draft.args,
        env: draft.env,
        advanced: draft.advanced,
      };
      try {
        if (editingAgent) {
          await ipcBridge.acpConversation.updateCustomAgent.invoke({ id: editingAgent.id, ...body });
        } else {
          await ipcBridge.acpConversation.createCustomAgent.invoke(body);
        }
        await refreshCatalog();
        setEditorVisible(false);
        setEditingAgent(null);
      } catch (err) {
        console.error('save custom agent failed:', err);
        Message.error(parseError(err));
      }
    },
    [editingAgent, refreshCatalog]
  );

  const handleDeleteCustomAgent = useCallback(
    async (agentId: string) => {
      try {
        await ipcBridge.acpConversation.deleteCustomAgent.invoke({ id: agentId });
        await refreshCatalog();
      } catch (err) {
        console.error('delete custom agent failed:', err);
        Message.error(parseError(err));
      }
    },
    [refreshCatalog]
  );

  const handleToggleCustomAgent = useCallback(
    async (agentId: string, enabled: boolean) => {
      try {
        await ipcBridge.acpConversation.setAgentEnabled.invoke({ id: agentId, enabled });
        await refreshCatalog();
      } catch (err) {
        console.error('toggle custom agent failed:', err);
        Message.error(parseError(err));
      }
    },
    [refreshCatalog]
  );

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const matchesAgentSearch = useCallback(
    (agent: ManagedAgent) => {
      if (!normalizedSearchQuery) return true;
      const searchableText = [
        agent.name,
        agent.name_i18n?.[i18n.language],
        agent.description,
        agent.description_i18n?.[i18n.language],
        agent.backend,
        agent.command,
        agent.agent_source_info?.binary_name,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return searchableText.includes(normalizedSearchQuery);
    },
    [i18n.language, normalizedSearchQuery]
  );

  const sortedOfficialAgents = useMemo(
    () =>
      officialAgents.toSorted((left, right) => {
        return left.name.localeCompare(right.name);
      }),
    [officialAgents]
  );
  const officialFilterStats = getAgentAvailabilityFilterStats(sortedOfficialAgents);
  const visibleOfficialAgents = filterAgentsByAvailability(
    sortedOfficialAgents.filter(matchesAgentSearch),
    agentFilter
  );
  const visibleCustomAgents = customAgents.filter(matchesAgentSearch);

  const openCustomAgentEditor = useCallback(() => {
    setEditingAgent(null);
    setEditorVisible(true);
  }, []);

  const openAgentConfig = useCallback(
    (agentId: string) => {
      navigate(`/settings/agent/${agentId}/repair`);
    },
    [navigate]
  );

  // Manual "test connection": runs the live ACP probe (initialize +
  // session/new) and refreshes the catalog so the card reflects the new
  // status immediately (F2-02: three states stay clickable, in-progress
  // feedback, recover-on-success).
  const handleTestConnection = useCallback(
    async (agentId: string) => {
      try {
        setTestingAgentId(agentId);
        const result = await ipcBridge.acpConversation.checkManagedAgentHealthById.invoke({ id: agentId });
        await refreshCatalog();
        switch (result.status) {
          case 'online':
            Message.success(t('settings.agentManagement.testConnectionOnline', { name: result.name }));
            break;
          case 'missing':
            Message.warning(t('settings.agentManagement.testConnectionMissing', { name: result.name }));
            break;
          case 'offline':
            // auth_required is offline-with-a-reason: surface the diagnostic
            // (which carries the "needs sign-in" guidance) when present.
            Message.warning(
              formatManagedAgentDiagnosticMessage(t, result) ||
                (result.last_check_error_code === 'auth_required'
                  ? t('settings.agentManagement.testConnectionAuth', { name: result.name })
                  : t('settings.agentManagement.testConnectionOffline', { name: result.name }))
            );
            break;
          default:
            break;
        }
      } catch (error) {
        console.error('test managed agent failed:', error);
        Message.error(t('settings.agentManagement.testConnectionError'));
      } finally {
        setTestingAgentId(null);
      }
    },
    [refreshCatalog, t]
  );

  return (
    <div data-testid='agent-management-page' className='flex flex-col gap-16px'>
      <SettingsPageHeader
        data-testid='agent-management-header'
        title={t('settings.agents', { defaultValue: 'Agents' })}
        description={t('settings.agentManagement.localAgentsDescription')}
        actions={
          <>
            {!isMobile && (
              <AionSearchInput
                className='shrink-0 w-[200px] hidden md:flex'
                data-testid='input-search-agents'
                placeholder={t('settings.agentManagement.searchPlaceholder', { defaultValue: 'Search agents...' })}
                value={searchQuery}
                onChange={setSearchQuery}
              />
            )}
            <TalkToButlerButton
              label={t('settings.agentManagement.addCustomAgent', { defaultValue: 'Add custom Agent' })}
              chatLabel={t('settings.talkToButler.addViaChat', { defaultValue: 'Add via chat' })}
              onManual={openCustomAgentEditor}
              manualLabel={t('settings.talkToButler.addManually', { defaultValue: 'Add manually' })}
              prompt={t('settings.talkToButler.prompt.addCustomAgent', {
                defaultValue: 'Help me add a custom Agent.',
              })}
              data-testid='btn-add-custom-agent'
            />
          </>
        }
        tabs={[
          {
            key: 'all',
            label: t('settings.agentManagement.filterAll', { defaultValue: 'All' }),
            count: officialFilterStats.all,
          },
          {
            key: 'available',
            label: t('settings.agentManagement.filterAvailable', { defaultValue: 'Available' }),
            count: officialFilterStats.available,
          },
        ]}
        activeTab={agentFilter}
        onTabChange={(key) => setAgentFilter(key as VisibleAgentAvailabilityFilter)}
      />

      {isRefreshing ? (
        <div className='text-11px text-t-tertiary'>{t('settings.agentManagement.refreshingStatuses')}</div>
      ) : null}

      {openCodePreparation ? (
        <Alert
          type={openCodePreparation.type}
          content={openCodePreparation.message}
          className={`${PREPARATION_ALERT_BASE_CLASS} ${PREPARATION_ALERT_TONE_CLASS[openCodePreparation.type]}`}
        />
      ) : null}

      {/* Detected Agents section */}
      <div data-testid='agent-management-official-section'>
        <div className='flex flex-col gap-8px rounded-12px border border-border-2 bg-2 p-8px md:rounded-16px md:p-10px'>
          {visibleOfficialAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              type='official'
              agent={agent}
              boundAssistants={getBoundAssistants(agent, assistants)}
              onTestConnection={() => void handleTestConnection(agent.id)}
              onConfigure={() => openAgentConfig(agent.id)}
              isTesting={testingAgentId === agent.id}
            />
          ))}
          {visibleOfficialAgents.length === 0 && (
            <Typography.Text type='secondary' className='block py-16px text-center text-12px'>
              {normalizedSearchQuery
                ? t('settings.agentManagement.noSearchResults', { defaultValue: 'No matching agents.' })
                : t('settings.agentManagement.localAgentsEmpty')}
            </Typography.Text>
          )}
        </div>
      </div>

      <div data-testid='agent-management-custom-header' className='flex flex-col gap-2px'>
        <Typography.Text className='text-13px font-medium text-t-secondary block'>
          {t('settings.agentManagement.customAgents', { defaultValue: 'Custom Agents' })}
        </Typography.Text>
        <Typography.Text className='block text-12px text-t-tertiary'>
          {t('settings.agentManagement.customEmptyDescription')}
        </Typography.Text>
      </div>

      <AionModal
        visible={editorVisible}
        onCancel={() => {
          setEditorVisible(false);
          setEditingAgent(null);
        }}
        header={{
          title: editingAgent
            ? t('settings.agentManagement.editCustomAgent')
            : t('settings.agentManagement.detectCustomAgent'),
          showClose: true,
        }}
        footer={null}
        style={{ maxWidth: '92vw', borderRadius: 16 }}
        contentStyle={{
          background: 'var(--dialog-fill-0)',
          borderRadius: 16,
          padding: '20px 24px 16px',
          overflow: 'auto',
        }}
      >
        {editorVisible && (
          <InlineAgentEditor
            key={editingAgent?.id ?? 'new'}
            agent={editingAgent}
            onSave={(agent) => void handleSaveCustomAgent(agent)}
            onCancel={() => {
              setEditorVisible(false);
              setEditingAgent(null);
            }}
          />
        )}
      </AionModal>

      <div data-testid='agent-management-custom-section'>
        <div className='flex flex-col gap-8px rounded-12px border border-border-2 bg-2 p-8px md:rounded-16px md:p-10px'>
          {visibleCustomAgents?.map((agent) => (
            <AgentCard
              key={agent.id}
              type='custom'
              agent={agent}
              boundAssistants={getBoundAssistants(agent, assistants)}
              onTestConnection={() => void handleTestConnection(agent.id)}
              onConfigure={() => openAgentConfig(agent.id)}
              isTesting={testingAgentId === agent.id}
              onEdit={() => {
                setEditingAgent(agent);
                setEditorVisible(true);
              }}
              onDelete={() => void handleDeleteCustomAgent(agent.id)}
              onToggle={(enabled) => void handleToggleCustomAgent(agent.id, enabled)}
            />
          ))}
          {visibleCustomAgents.length === 0 ? (
            <Typography.Text type='secondary' className='block py-12px text-center text-12px'>
              {normalizedSearchQuery
                ? t('settings.agentManagement.noSearchResults', { defaultValue: 'No matching agents.' })
                : t('settings.agentManagement.customEmpty')}
            </Typography.Text>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default LocalAgents;
