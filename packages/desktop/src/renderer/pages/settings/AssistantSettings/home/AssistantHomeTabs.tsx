/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AssistantListItem } from '../types';
import EnabledAssistantsList from './EnabledAssistantsList';
import MyAssistantsList from './MyAssistantsList';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import TalkToButlerButton from '@/renderer/components/base/TalkToButlerButton';
import { AionSearchInput } from '@/renderer/components/base';
import SettingsPageHeader from '../../components/SettingsPageHeader';
import { Button } from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type AssistantHomeTabsProps = {
  assistants: AssistantListItem[];
  assistantOrder: readonly string[];
  localeKey: string;
  onOpenDetail: (assistant: AssistantListItem) => void;
  onDelete: (assistant: AssistantListItem) => void;
  onCreate: () => void;
  onToggleEnabled: (assistant: AssistantListItem, checked: boolean) => void;
  onReorderEnabled: (activeId: string, overId: string) => void | Promise<void>;
  onStartChat: (assistant: AssistantListItem) => void;
  onSyncFromHTH: () => void | Promise<void>;
  syncingFromHTH: boolean;
  initialTab?: HomeTab;
  /** Notified whenever the active tab changes, so the parent can remember it. */
  onTabChange?: (tab: HomeTab) => void;
};

export type HomeTab = 'enabled' | 'mine';

const formatHTHText = (value: string): string => value.replace(/hth/gi, 'HTH');

const AssistantHomeTabs: React.FC<AssistantHomeTabsProps> = ({
  assistants,
  assistantOrder,
  localeKey,
  onOpenDetail,
  onDelete,
  onCreate,
  onToggleEnabled,
  onReorderEnabled,
  onStartChat,
  onSyncFromHTH,
  syncingFromHTH,
  initialTab = 'enabled',
  onTabChange,
}) => {
  const { t, i18n } = useTranslation();
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const [tab, setTab] = useState<HomeTab>(initialTab);
  const [searchQuery, setSearchQuery] = useState('');

  const selectTab = (next: HomeTab) => {
    setTab(next);
    onTabChange?.(next);
  };

  const customAssistants = useMemo(() => assistants.filter((assistant) => assistant.source === 'user'), [assistants]);

  const counts = useMemo(() => {
    let enabled = 0;
    for (const assistant of customAssistants) {
      if (assistant.enabled !== false) enabled += 1;
    }
    return { enabled, mine: customAssistants.length };
  }, [customAssistants]);

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredAssistants = useMemo(() => {
    if (!normalizedSearchQuery) return customAssistants;
    return customAssistants.filter((assistant) => {
      const searchableText = [
        assistant.name,
        assistant.name_i18n?.[i18n.language],
        assistant.description,
        assistant.description_i18n?.[i18n.language],
        assistant.agent?.type,
        assistant.agent?.acp_backend,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return searchableText.includes(normalizedSearchQuery);
    });
  }, [customAssistants, i18n.language, normalizedSearchQuery]);

  return (
    <div data-testid='assistant-home-shell' className='flex h-full min-h-0 flex-col overflow-hidden bg-transparent'>
      <div
        className={`border-b border-border-2 bg-bg-0 ${isMobile ? 'px-16px pt-14px' : 'px-12px pt-24px md:px-40px md:pt-32px'}`}
      >
        <div className='mx-auto w-full max-w-800px'>
          <SettingsPageHeader
            data-testid='assistants-header'
            title={t('settings.assistants', { defaultValue: 'Assistants' })}
            description={t('settings.assistantHomeLeadShort', {
              defaultValue:
                'Ready-to-work AI experts, preloaded with skills. Enable one and it shows up wherever you pick an assistant.',
            })}
            actions={
              <>
                {!isMobile && (
                  <AionSearchInput
                    className='shrink-0 w-[200px] hidden md:flex'
                    data-testid='input-search-assistants'
                    placeholder={t('settings.searchAssistants', {
                      defaultValue: 'Search assistants by name or description',
                    })}
                    value={searchQuery}
                    onChange={setSearchQuery}
                  />
                )}
                <TalkToButlerButton
                  className='shrink-0'
                  label={t('settings.createAssistant', { defaultValue: 'Create Assistant' })}
                  chatLabel={t('settings.talkToButler.createViaChat', { defaultValue: 'Create via chat' })}
                  onManual={onCreate}
                  manualLabel={t('settings.talkToButler.createManually', { defaultValue: 'Create manually' })}
                  prompt={t('settings.talkToButler.prompt.createAssistant', {
                    defaultValue: 'Help me create a new assistant and walk me through setting it up.',
                  })}
                  data-testid='btn-create-assistant'
                />
                <Button
                  type='outline'
                  className='shrink-0 !border-primary-5 !bg-primary-1 !text-primary-6 hover:!border-primary-6 hover:!bg-primary-2'
                  loading={syncingFromHTH}
                  onClick={() => void onSyncFromHTH()}
                >
                  <span className='inline-flex items-center gap-8px font-500'>
                    {!syncingFromHTH && <Refresh theme='outline' size='16' />}
                    <span>{formatHTHText(t('settings.hth.syncAssistants'))}</span>
                  </span>
                </Button>
              </>
            }
            tabs={[
              {
                key: 'enabled',
                label: t('settings.assistantSectionEnabled', { defaultValue: 'Enabled' }),
                count: counts.enabled,
              },
              {
                key: 'mine',
                label: t('settings.assistantTabMine', { defaultValue: 'My Assistants' }),
                count: counts.mine,
              },
            ]}
            activeTab={tab}
            onTabChange={(key) => selectTab(key as HomeTab)}
          />
        </div>
      </div>

      <div
        data-testid='assistant-home-body'
        className={`min-h-0 flex-1 overflow-auto ${isMobile ? 'px-16px pb-14px pt-14px' : 'px-12px pb-24px pt-18px md:px-40px'}`}
      >
        <div className='mx-auto w-full max-w-800px'>
          {tab === 'enabled' ? (
            <EnabledAssistantsList
              assistants={filteredAssistants}
              assistantOrder={assistantOrder}
              localeKey={localeKey}
              searchActive={Boolean(normalizedSearchQuery)}
              onOpenDetail={onOpenDetail}
              onToggleEnabled={onToggleEnabled}
              onReorder={onReorderEnabled}
            />
          ) : tab === 'mine' ? (
            <MyAssistantsList
              assistants={filteredAssistants}
              localeKey={localeKey}
              onOpenDetail={onOpenDetail}
              onDelete={onDelete}
              onToggleEnabled={onToggleEnabled}
              onStartChat={onStartChat}
              searchActive={Boolean(normalizedSearchQuery)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default AssistantHomeTabs;
