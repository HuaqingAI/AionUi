/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider } from '@arco-design/web-react';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import AssistantDescriptionPanel from '@/renderer/components/assistant/AssistantDescriptionPanel';
import { emitter } from '@/renderer/utils/emitter';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@icon-park/react', () => ({
  ArrowRightUp: () => <span data-testid='prompt-arrow' />,
}));

const assistant: Assistant = {
  id: 'hth-assistant',
  source: 'user',
  name: '运营助手',
  name_i18n: {},
  description: '第一行说明\n第二行说明',
  description_i18n: {},
  enabled: true,
  sort_order: 1,
  agent_id: 'agent-1',
  enabled_skills: [],
  custom_skill_names: [],
  disabled_builtin_skills: [],
  context_i18n: {},
  prompts: ['生成本周运营总结'],
  prompts_i18n: {},
  models: [],
  agent_status: 'online',
  team_selectable: true,
  deletable: true,
};

describe('AssistantDescriptionPanel', () => {
  it('preserves description line breaks and fills the send box with a prompt', () => {
    const emitSpy = vi.spyOn(emitter, 'emit');

    render(
      <ConfigProvider>
        <AssistantDescriptionPanel assistant={assistant} />
      </ConfigProvider>
    );

    expect(screen.getByTestId('assistant-description-panel').firstElementChild?.textContent).toBe(
      '第一行说明\n第二行说明'
    );
    expect(screen.getByText('生成本周运营总结')).toBeInTheDocument();

    fireEvent.click(screen.getByText('生成本周运营总结'));

    expect(emitSpy).toHaveBeenCalledWith('sendbox.replace', '生成本周运营总结');
    emitSpy.mockRestore();
  });

  it('can hide prompts for the home page description-only view', () => {
    render(
      <ConfigProvider>
        <AssistantDescriptionPanel assistant={assistant} showPrompts={false} />
      </ConfigProvider>
    );

    expect(screen.getByTestId('assistant-description-panel').firstElementChild?.textContent).toBe(
      '第一行说明\n第二行说明'
    );
    expect(screen.queryByText('生成本周运营总结')).not.toBeInTheDocument();
  });
});
