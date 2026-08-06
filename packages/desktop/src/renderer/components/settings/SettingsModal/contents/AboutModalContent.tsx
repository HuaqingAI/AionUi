/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Typography, Button, Message } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import classNames from 'classnames';
import { useSettingsViewMode } from '../settingsViewContext';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { ipcBridge } from '@/common';
import { runUpdateCheck } from '@/renderer/components/settings/checkForUpdatesShared';
import { UPDATE_AVAILABLE_EVENT } from '@/renderer/components/settings/useUpdateNotificationController';
import {
  getUpdateReadyState,
  setUpdateReadyState,
  subscribeUpdateReadyState,
  type UpdateReadyState,
} from '@/renderer/components/settings/updateReadyState';

// __APP_VERSION__ is injected by electron.vite.config.ts `define:` from the
// repo-root package.json. The previous `import packageJson from
// '../../../../../../package.json'` resolved to packages/desktop/package.json
// which is a workspace placeholder permanently pinned at "0.0.0".
declare const __APP_VERSION__: string;

const AboutModalContent: React.FC = () => {
  const { t } = useTranslation();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const isElectron = isElectronDesktop();

  const [updateReadyState, setLocalUpdateReadyState] = useState<UpdateReadyState>(() => getUpdateReadyState());
  const [checking, setChecking] = useState(false);

  useEffect(() => subscribeUpdateReadyState(setLocalUpdateReadyState), []);

  const checkUpdate = async () => {
    if (updateReadyState.ready) {
      if (updateReadyState.preparing) return;
      if (updateReadyState.filePath) {
        void ipcBridge.shell.openFile.invoke(updateReadyState.filePath);
        return;
      }
      setUpdateReadyState({ ...updateReadyState, preparing: true });
      void ipcBridge.autoUpdate.quitAndInstall.invoke().catch(() => {
        Message.error(t('update.errors.prepareInstallFailed'));
        setUpdateReadyState({ ...updateReadyState, preparing: false });
      });
      return;
    }

    if (checking) return;
    setChecking(true);
    try {
      const outcome = await runUpdateCheck({
        includePrerelease: false,
        fallbackVersion: __APP_VERSION__,
        checkFailedLabel: t('update.checkFailed'),
      });
      if (outcome.kind === 'available') {
        // Only reveal the bottom-right card once an update is confirmed; hand
        // over the already-fetched outcome so the card skips the checking flash.
        window.dispatchEvent(new CustomEvent(UPDATE_AVAILABLE_EVENT, { detail: outcome }));
      } else if (outcome.kind === 'upToDate') {
        Message.info(t('update.alreadyLatest'));
      } else {
        Message.error(outcome.message || t('update.checkFailed'));
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className='flex flex-col h-full w-full'>
      {/* Content Area */}
      <div
        className={classNames(
          'flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-24px',
          isPageMode && 'px-0 overflow-visible'
        )}
      >
        <div className='flex flex-col max-w-500px mx-auto'>
          {/* App Info Section */}
          <div className='flex flex-col items-center pb-24px'>
            <Typography.Title heading={3} className='text-24px font-bold text-t-primary mb-8px'>
              HTHBuddy
            </Typography.Title>
            <Typography.Text className='text-14px text-t-secondary mb-12px text-center'>
              {t('settings.appDescription')}
            </Typography.Text>
            <div className='flex items-center justify-center gap-8px mb-16px'>
              <span className='px-10px py-4px rd-6px text-13px bg-fill-2 text-t-primary font-500'>
                v{__APP_VERSION__}
              </span>
            </div>

            {/* Check Update Section */}
            {isElectron && (
              <div className='flex flex-col items-center gap-12px w-full max-w-300px bg-fill-2 p-16px rounded-lg'>
                <Button
                  type='primary'
                  long
                  loading={checking || updateReadyState.preparing}
                  disabled={updateReadyState.preparing}
                  onClick={() => void checkUpdate()}
                >
                  {updateReadyState.preparing
                    ? t('update.preparingInstall')
                    : updateReadyState.ready
                      ? t('settings.updateReadyInstall', { version: updateReadyState.version })
                      : checking
                        ? t('settings.checkingForUpdates')
                        : t('settings.checkForUpdates')}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AboutModalContent;
