/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HTHSyncProgressEvent } from '@/common/types/hth';
import { Modal, Progress, Tooltip } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

type AssistantSyncProgressModalProps = {
  visible: boolean;
  progress: HTHSyncProgressEvent;
};

const AssistantSyncProgressModal: React.FC<AssistantSyncProgressModalProps> = ({ visible, progress }) => {
  const { t } = useTranslation();
  const percent =
    progress.total > 0 ? Math.max(0, Math.min(100, Math.floor((progress.completed / progress.total) * 100))) : 0;
  const currentAssistant =
    progress.stage === 'syncing_assistants'
      ? progress.currentAssistant
        ? progress.currentAssistant.name ||
          t('settings.hth.syncUnnamedAssistant', { defaultValue: 'Unnamed assistant' })
        : t('settings.hth.syncPreparingAssistant', { defaultValue: 'Preparing synchronization' })
      : progress.stage === 'saving_assistants'
        ? t('settings.hth.syncSavingAssistants', { defaultValue: 'Saving assistant information' })
        : progress.stage === 'removing_revoked'
          ? t('settings.hth.syncFinalizingAssistant', { defaultValue: 'Finalizing synchronization' })
          : t('settings.hth.syncPreparingAssistant', { defaultValue: 'Preparing synchronization' });
  const step =
    progress.stage === 'syncing_assistants'
      ? t('settings.hth.syncingAssistant', { defaultValue: 'Downloading and configuring assistant' })
      : progress.stage === 'saving_assistants'
        ? t('settings.hth.syncSavingAssistants', { defaultValue: 'Saving assistant information' })
        : progress.stage === 'removing_revoked'
          ? t('settings.hth.syncRemovingRevoked', { defaultValue: 'Cleaning up revoked assistants' })
          : t('settings.hth.syncProgressPreparing', { defaultValue: 'Fetching assistant list' });

  return (
    <Modal
      visible={visible}
      title={t('settings.hth.syncProgressTitle', { defaultValue: 'Syncing assistants' })}
      footer={null}
      closable={false}
      maskClosable={false}
      escToExit={false}
      className='w-[calc(100vw-32px)] max-w-460px'
      data-testid='assistant-sync-progress-modal'
    >
      <div className='flex flex-col gap-18px' aria-live='polite' role='status'>
        {progress.total > 0 ? (
          <div className='flex flex-col gap-8px'>
            <Progress percent={percent} showText={false} strokeWidth={6} />
            <div className='flex items-center justify-between gap-12px text-12px text-t-tertiary'>
              <span>{percent}%</span>
              <span data-testid='assistant-sync-progress-processed'>
                {t('settings.hth.syncProgressProcessed', {
                  completed: progress.completed,
                  total: progress.total,
                  defaultValue: 'Processed {{completed}} / {{total}}',
                })}
              </span>
            </div>
          </div>
        ) : (
          <div className='text-13px text-t-secondary'>
            {t('settings.hth.syncProgressPreparing', { defaultValue: 'Fetching assistant list' })}
          </div>
        )}

        <div className='grid grid-cols-[auto_1fr] items-center gap-x-16px gap-y-10px text-13px'>
          <span className='text-t-tertiary'>{t('settings.hth.syncTotal', { defaultValue: 'Total assistants' })}</span>
          <span className='text-t-primary' data-testid='assistant-sync-progress-total'>
            {progress.total}
          </span>
          <span className='text-t-tertiary'>{t('settings.hth.syncCompleted', { defaultValue: 'Synced' })}</span>
          <span className='text-t-primary' data-testid='assistant-sync-progress-synced'>
            {progress.synced}
          </span>
          <span className='text-t-tertiary'>{t('settings.hth.syncFailedCount', { defaultValue: 'Failed' })}</span>
          <span className='text-t-primary' data-testid='assistant-sync-progress-failed'>
            {progress.failed}
          </span>
          <span className='text-t-tertiary'>
            {t('settings.hth.syncCurrentAssistant', { defaultValue: 'Currently syncing' })}
          </span>
          <Tooltip content={currentAssistant}>
            <span className='min-w-0 truncate text-t-primary' data-testid='assistant-sync-progress-current'>
              {currentAssistant}
            </span>
          </Tooltip>
          <span className='text-t-tertiary'>{t('settings.hth.syncCurrentStep', { defaultValue: 'Current step' })}</span>
          <span className='min-w-0 truncate text-t-primary' data-testid='assistant-sync-progress-step'>
            {step}
          </span>
        </div>
      </div>
    </Modal>
  );
};

export default AssistantSyncProgressModal;
