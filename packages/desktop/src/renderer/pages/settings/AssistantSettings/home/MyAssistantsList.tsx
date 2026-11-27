/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AssistantListItem } from '../types';
import type { HTHAssistantUpdate } from '@/common/types/hth';
import { ASSISTANT_CATEGORY_CODES, type AssistantCategoryCode } from '@/common/types/agent/assistantCategories';
import {
  type AssistantEnabledFilter,
  filterByEnabled,
  groupAssistantsByCategory,
  groupMyAssistants,
} from '../assistantUtils';
import MyAssistantCard from './MyAssistantCard';
import { Dropdown, Menu, Button, Tabs } from '@arco-design/web-react';
import { Down } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type MyAssistantsListProps = {
  assistants: AssistantListItem[];
  /** Complete list before search, so category tabs remain available while searching. */
  categoryAssistants?: AssistantListItem[];
  assistantUpdates?: ReadonlyMap<string, HTHAssistantUpdate>;
  localeKey: string;
  onOpenDetail: (assistant: AssistantListItem) => void;
  onDelete: (assistant: AssistantListItem) => void;
  onToggleEnabled: (assistant: AssistantListItem, checked: boolean) => void;
  onStartChat: (assistant: AssistantListItem) => void;
  searchActive?: boolean;
};

const FILTER_OPTIONS: AssistantEnabledFilter[] = ['all', 'enabled', 'disabled'];
type AssistantCategoryTab = 'all' | AssistantCategoryCode;
const CATEGORY_TABS: AssistantCategoryTab[] = [
  'all',
  ...ASSISTANT_CATEGORY_CODES.filter((code) => code !== 'custom_assistant'),
  'custom_assistant',
];

const MyAssistantsList: React.FC<MyAssistantsListProps> = ({
  assistants,
  categoryAssistants = assistants,
  assistantUpdates,
  localeKey,
  onOpenDetail,
  onDelete,
  onToggleEnabled,
  onStartChat,
  searchActive = false,
}) => {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<AssistantEnabledFilter>('all');
  const [category, setCategory] = useState<AssistantCategoryTab>('all');

  const availableCategories = useMemo(() => {
    const { createdAssistants } = groupMyAssistants(categoryAssistants);
    return new Set(groupAssistantsByCategory(createdAssistants).map((group) => group.code));
  }, [categoryAssistants]);
  const categoryTabs = CATEGORY_TABS.filter((code) => code === 'all' || availableCategories.has(code));
  const activeCategory = categoryTabs.includes(category) ? category : 'all';
  const { createdAssistants } = useMemo(() => {
    const filtered = filterByEnabled(assistants, filter);
    return groupMyAssistants(filtered);
  }, [assistants, filter]);
  const categoryGroups = useMemo(() => groupAssistantsByCategory(createdAssistants), [createdAssistants]);
  const visibleAssistants =
    activeCategory === 'all'
      ? createdAssistants
      : (categoryGroups.find((group) => group.code === activeCategory)?.assistants ?? []);

  const filterMenu = (
    <Menu onClickMenuItem={(key) => setFilter(key as AssistantEnabledFilter)}>
      {FILTER_OPTIONS.map((option) => (
        <Menu.Item key={option} data-testid={`filter-option-${option}`}>
          {t(`settings.assistantFilter.${option}`, {
            defaultValue: option === 'all' ? 'All' : option === 'enabled' ? 'Enabled' : 'Disabled',
          })}
        </Menu.Item>
      ))}
    </Menu>
  );

  const cardGrid = (
    <div className='grid grid-cols-1 gap-14px sm:grid-cols-2 lg:grid-cols-3'>
      {visibleAssistants.map((assistant) => (
        <MyAssistantCard
          key={assistant.id}
          assistant={assistant}
          update={assistantUpdates?.get(assistant.id)}
          localeKey={localeKey}
          onOpenDetail={onOpenDetail}
          onDelete={onDelete}
          onToggleEnabled={onToggleEnabled}
          onStartChat={onStartChat}
        />
      ))}
    </div>
  );

  const createdEmpty = createdAssistants.length === 0 && filter === 'all' && activeCategory === 'all' && !searchActive;

  const emptyState = createdEmpty ? (
    <div
      className='flex flex-col items-center rounded-14px border border-dashed border-border-2 bg-fill-1/40 px-20px py-28px text-center'
      data-testid='created-empty'
    >
      <div className='mb-6px text-13px font-600 text-t-primary'>
        {t('settings.customEmptyTitle', { defaultValue: "You don't have any assistants yet" })}
      </div>
    </div>
  ) : (
    <div className='rounded-14px border border-dashed border-border-2 bg-fill-1/40 px-20px py-28px text-center text-13px text-t-secondary'>
      {t('settings.assistantNoMatch', { defaultValue: 'No assistants match the current filters.' })}
    </div>
  );
  const activePanel = visibleAssistants.length > 0 ? cardGrid : emptyState;

  return (
    <div data-testid='my-assistants-pane' className='min-w-0'>
      <Tabs
        activeTab={activeCategory}
        onChange={(key) => setCategory(key as AssistantCategoryTab)}
        type='line'
        size='small'
        headerPadding={false}
        overflow='scroll'
        destroyOnHide
        renderTabHeader={(tabProps, DefaultTabHeader) => (
          <div role='tablist' aria-label={t('settings.assistantTabMine', { defaultValue: 'My Assistants' })}>
            <DefaultTabHeader {...tabProps} />
          </div>
        )}
        extra={
          <Dropdown droplist={filterMenu} trigger='click' position='br'>
            <Button
              size='mini'
              data-testid='assistant-enabled-filter'
              className='!flex !shrink-0 !items-center !gap-4px !rounded-8px'
            >
              <span>
                {t(`settings.assistantFilter.${filter}`, {
                  defaultValue: filter === 'all' ? 'All' : filter === 'enabled' ? 'Enabled' : 'Disabled',
                })}
              </span>
              <Down theme='outline' size={12} fill='currentColor' />
            </Button>
          </Dropdown>
        }
      >
        {categoryTabs.map((code) => (
          <Tabs.TabPane
            key={code}
            title={
              code === 'all'
                ? t('settings.assistantFilter.all', { defaultValue: 'All' })
                : t(`settings.assistantCategory.${code}`, { defaultValue: code }).replace(/助手$/, '')
            }
          >
            {code === activeCategory ? activePanel : null}
          </Tabs.TabPane>
        ))}
      </Tabs>
    </div>
  );
};

export default MyAssistantsList;
