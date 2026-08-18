/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { isHTHUnauthorizedSyncResult } from '@/common/types/hth';
import AppLoader from '@renderer/components/layout/AppLoader';
import AppLogo from '@renderer/components/layout/AppLogo';
import WindowControls from '@renderer/components/layout/WindowControls';
import { isElectronDesktop, isMacOS } from '@renderer/utils/platform';
import { Button, Input, Message, Typography } from '@arco-design/web-react';
import { Down, Right } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import '@renderer/components/layout/Titlebar/titlebar.css';
import styles from './index.module.css';

const formatHTHText = (value: string): string => value.replace(/hth/gi, 'HTH');

const HTHLogin: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [baseUrl, setBaseUrl] = useState('');
  const [baseUrlVisible, setBaseUrlVisible] = useState(false);
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(false);
  const disposedRef = useRef(false);
  const isMacRuntime = isElectronDesktop() && isMacOS();
  const showWindowControls = isElectronDesktop() && !isMacRuntime;

  useEffect(() => {
    let disposed = false;
    disposedRef.current = false;
    ipcBridge.hth.authStatus
      .invoke()
      .then((status) => {
        if (disposed) return;
        if (status.loggedIn) {
          void navigate('/guid', { replace: true });
          return;
        }
        setBaseUrl(status.baseUrl || '');
      })
      .catch((error) => {
        console.error('[HTHLogin] Failed to load auth status:', error);
      })
      .finally(() => {
        if (!disposed) {
          setChecking(false);
        }
      });
    return () => {
      disposed = true;
      disposedRef.current = true;
    };
  }, [navigate]);

  const completeLogin = useCallback(async () => {
    try {
      const syncResult = await ipcBridge.hth.syncAgentConfigs.invoke({ force: true });
      if (isHTHUnauthorizedSyncResult(syncResult)) {
        if (!disposedRef.current) {
          await navigate('/hth-login', { replace: true });
        }
        return;
      }
    } catch (error) {
      console.error('[HTHLogin] Failed to sync hth configs after login:', error);
      Message.warning(formatHTHText(t('settings.hth.syncFailed')));
    }
    if (!disposedRef.current) {
      await navigate('/guid', { replace: true });
    }
  }, [navigate, t]);

  const waitForAuthStatus = useCallback(async (): Promise<boolean> => {
    const deadline = Date.now() + 2 * 60 * 1000;
    while (!disposedRef.current && Date.now() < deadline) {
      const status = await ipcBridge.hth.authStatus.invoke();
      if (status.loggedIn) {
        await completeLogin();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }, [completeLogin]);

  const handleLogin = useCallback(async () => {
    setLoading(true);
    try {
      await ipcBridge.hth.startLogin.invoke({ baseUrl: baseUrl.trim() || undefined });
      Message.info(formatHTHText(t('login.hth.browserOpened')));
      const loggedIn = await waitForAuthStatus();
      if (!loggedIn && !disposedRef.current) {
        Message.error(formatHTHText(t('login.hth.exchangeFailed')));
      }
    } catch (error) {
      console.error('[HTHLogin] Failed to start login:', error);
      Message.error(formatHTHText(t('login.hth.startFailed')));
    } finally {
      setLoading(false);
    }
  }, [baseUrl, t, waitForAuthStatus]);

  if (checking) {
    return <AppLoader />;
  }

  return (
    <div className='flex h-full w-full flex-col bg-bg-0'>
      <div className={`${styles.loginTitlebar} ${isMacRuntime ? styles.loginTitlebarMac : ''}`}>
        <div className={styles.loginTitlebarBrand} data-testid='hth-login-titlebar-brand'>
          <AppLogo className={styles.loginTitlebarLogo} title={t('login.brand')} />
          <span>{t('login.brand')}</span>
        </div>
        {showWindowControls && <WindowControls />}
      </div>
      <main className={styles.loginCanvas}>
        <section className={styles.loginPanel} aria-label={t('login.hth.title')}>
          <div className={styles.brandPanel}>
            <div className={styles.brandLogoShell}>
              <AppLogo className={styles.brandLogo} title={t('login.brand')} />
            </div>
            <Typography.Title heading={3} className={styles.brandName}>
              {t('login.brand')}
            </Typography.Title>
            <div className={styles.brandRule} aria-hidden='true' />
          </div>

          <div className={styles.formPanel}>
            <div className={styles.formHeader}>
              <Typography.Title heading={4} className='!m-0 text-t-primary'>
                {t('login.hth.title')}
              </Typography.Title>
              <Typography.Text className='text-t-secondary'>{t('login.hth.description')}</Typography.Text>
            </div>

            <div className={styles.endpointSection}>
              <Button
                type='text'
                size='small'
                className={styles.endpointToggle}
                icon={baseUrlVisible ? <Down /> : <Right />}
                disabled={loading}
                onClick={() => setBaseUrlVisible((visible) => !visible)}
              >
                {t('login.hth.baseUrl')}
              </Button>
              {baseUrlVisible && (
                <Input
                  value={baseUrl}
                  onChange={setBaseUrl}
                  placeholder={baseUrl || t('login.hth.baseUrlPlaceholder')}
                  disabled={loading}
                />
              )}
            </div>

            <Button className={styles.loginButton} type='primary' loading={loading} onClick={handleLogin}>
              {t('login.hth.loginWithDingTalk')}
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
};

export default HTHLogin;
