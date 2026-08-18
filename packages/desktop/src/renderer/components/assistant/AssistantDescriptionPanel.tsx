/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Assistant } from '@/common/types/agent/assistantTypes';
import { resolveLocaleKey } from '@/common/utils';
import { emitter } from '@/renderer/utils/emitter';
import { ArrowRightUp } from '@icon-park/react';
import { Button } from '@arco-design/web-react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

type AssistantDescriptionPanelProps = {
  assistant: Assistant;
  localeKey?: string;
  description?: string;
  prompts?: string[];
  showPrompts?: boolean;
  className?: string;
};

const AssistantDescriptionPanel: React.FC<AssistantDescriptionPanelProps> = ({
  assistant,
  localeKey: localeKeyProp,
  description: descriptionProp,
  prompts: promptsProp,
  showPrompts = true,
  className = '',
}) => {
  const { t, i18n } = useTranslation();
  const localeKey = localeKeyProp || resolveLocaleKey(i18n.language);
  const description =
    descriptionProp ??
    assistant.description_i18n?.[localeKey] ??
    assistant.description_i18n?.['en-US'] ??
    assistant.description;
  const prompts = useMemo(
    () =>
      promptsProp ??
      assistant.prompts_i18n?.[localeKey] ??
      assistant.prompts_i18n?.['en-US'] ??
      assistant.prompts ??
      [],
    [assistant.prompts, assistant.prompts_i18n, localeKey, promptsProp]
  );

  if (!description?.trim() && (!showPrompts || prompts.length === 0)) {
    return null;
  }

  return (
    <section className={`w-full ${className}`} data-testid='assistant-description-panel'>
      {description?.trim() ? (
        <div className='whitespace-pre-wrap break-words text-13px leading-[1.7] text-t-secondary'>{description}</div>
      ) : null}
      {showPrompts && prompts.length > 0 ? (
        <div className='mt-12px flex flex-col gap-4px'>
          <div className='text-12px leading-20px text-t-tertiary'>
            {t('guid.promptExamplesHint', { defaultValue: 'Try these instructions' })}
          </div>
          {prompts.map((prompt, index) => (
            <Button
              key={`${index}-${prompt}`}
              type='text'
              className='group !h-auto !justify-start !border-none !bg-transparent !px-0 !py-5px !text-left !text-12.5px !text-t-secondary !whitespace-normal !break-words hover:!bg-transparent hover:!text-t-primary'
              onClick={() => {
                emitter.emit('sendbox.replace', prompt);
                window.requestAnimationFrame(() => {
                  document.querySelector<HTMLElement>('[data-testid="sendbox-input"]')?.focus();
                });
              }}
            >
              <span>{prompt}</span>
              <ArrowRightUp
                theme='outline'
                size='13'
                className='ml-6px inline-flex flex-shrink-0 align-[-1px] text-t-primary opacity-0 transition-opacity group-hover:opacity-100'
              />
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
};

export default AssistantDescriptionPanel;
