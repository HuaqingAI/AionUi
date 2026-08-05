/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Tooltip } from '@arco-design/web-react';
import { ArrowCircleLeft, CloseOne, Moon, Refresh, SettingTwo, SunOne, Wallet } from '@icon-park/react';
import classNames from 'classnames';
import { iconColors } from '@renderer/styles/colors';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';
import type { HTHQuotaSummary } from '@/common/types/hth';
import { ipcBridge } from '@/common';
import { showQuotaPromptIfSummaryExhausted } from '@renderer/pages/conversation/platforms/quotaErrorPrompt';

interface SiderFooterProps {
  isMobile: boolean;
  isSettings: boolean;
  collapsed?: boolean;
  theme: string;
  siderTooltipProps: SiderTooltipProps;
  onSettingsClick: () => void;
  onThemeToggle: () => void;
  showLogout?: boolean;
  onLogoutClick?: () => void;
}

const SiderFooter: React.FC<SiderFooterProps> = ({
  isMobile,
  isSettings,
  collapsed = false,
  theme,
  siderTooltipProps,
  onSettingsClick,
  onThemeToggle,
  showLogout = false,
  onLogoutClick,
}) => {
  const { t } = useTranslation();
  const [quotaSummary, setQuotaSummary] = useState<HTHQuotaSummary | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);

  const refreshQuota = useCallback(async (): Promise<HTHQuotaSummary | null> => {
    setQuotaLoading(true);
    try {
      const summary = await ipcBridge.hth.refreshQuotaSummary.invoke();
      setQuotaSummary(summary);
      return summary;
    } catch (error) {
      console.warn('[HTHQuota] Failed to refresh quota summary:', error);
      return null;
    } finally {
      setQuotaLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void ipcBridge.hth.quotaSummary
      .invoke()
      .then((summary) => {
        if (mounted && summary) {
          setQuotaSummary(summary);
        }
      })
      .catch((error) => {
        console.warn('[HTHQuota] Failed to read cached quota summary:', error);
      });
    void refreshQuota();
    return () => {
      mounted = false;
    };
  }, [refreshQuota]);

  useEffect(() => {
    return ipcBridge.conversation.turnCompleted.on(() => {
      void refreshQuota().then((summary) => {
        if (summary) {
          void showQuotaPromptIfSummaryExhausted(summary, t);
        }
      });
    });
  }, [refreshQuota, t]);

  const settingsIcon = isSettings ? (
    <ArrowCircleLeft
      theme='outline'
      size='16'
      fill='currentColor'
      className='block leading-none'
      style={{ lineHeight: 0 }}
    />
  ) : (
    <SettingTwo
      theme='outline'
      size='16'
      fill='currentColor'
      className='block leading-none'
      style={{ lineHeight: 0 }}
    />
  );
  const showThemeToggle = isSettings && !collapsed;
  const themeTooltip = theme === 'dark' ? t('settings.lightMode') : t('settings.darkMode');

  return (
    <div className='shrink-0 sider-footer mt-auto pt-8px pb-8px border-t border-solid border-[var(--color-border-2)] border-l-0 border-r-0 border-b-0'>
      <QuotaSummaryView
        collapsed={collapsed}
        loading={quotaLoading}
        summary={quotaSummary}
        siderTooltipProps={siderTooltipProps}
        onRefresh={refreshQuota}
      />
      <div className={classNames('flex', collapsed ? 'flex-col gap-2px' : 'items-center gap-2px')}>
        <Tooltip {...siderTooltipProps} content={isSettings ? t('common.back') : t('common.settings')} position='right'>
          <div
            onClick={onSettingsClick}
            className={classNames(
              'group h-34px flex items-center rd-0.5rem cursor-pointer transition-colors',
              collapsed ? 'w-full justify-center' : 'flex-1 min-w-0 justify-start gap-8px pl-10px pr-8px',
              isMobile && 'sider-footer-btn-mobile',
              {
                'bg-fill-3': isSettings,
                'hover:bg-fill-3 active:bg-fill-4': !isSettings,
              }
            )}
          >
            <span className='size-22px flex items-center justify-center shrink-0 text-t-secondary'>{settingsIcon}</span>
            <span className='collapsed-hidden text-t-primary text-14px font-[500] leading-24px truncate'>
              {isSettings ? t('common.back') : t('common.settings')}
            </span>
          </div>
        </Tooltip>
        {showLogout && onLogoutClick && (
          <Tooltip {...siderTooltipProps} content={t('settings.googleLogout')} position='right'>
            <div
              onClick={onLogoutClick}
              className={classNames(
                'h-32px flex items-center rd-0.5rem cursor-pointer transition-colors hover:bg-[rgba(var(--primary-6),0.14)] active:bg-fill-2',
                collapsed ? 'w-full justify-center' : 'flex-1 min-w-0 justify-start gap-10px px-14px',
                isMobile && 'sider-footer-btn-mobile'
              )}
            >
              <span className='size-20px flex items-center justify-center shrink-0'>
                <CloseOne
                  theme='outline'
                  size='16'
                  fill={iconColors.primary}
                  className='block leading-none'
                  style={{ lineHeight: 0 }}
                />
              </span>
              <span className='collapsed-hidden text-t-primary text-14px font-[500] leading-24px truncate'>
                {t('settings.googleLogout')}
              </span>
            </div>
          </Tooltip>
        )}
        {/* Theme toggle — lightweight icon button, only while inside Settings page (not in collapsed mode) */}
        {showThemeToggle && (
          <Tooltip {...siderTooltipProps} content={themeTooltip} position='right'>
            <div
              onClick={onThemeToggle}
              className={classNames(
                'h-32px w-40px shrink-0 flex items-center justify-center cursor-pointer rd-0.5rem transition-colors text-t-secondary hover:bg-fill-2 hover:text-t-primary active:bg-fill-3',
                isMobile && 'sider-footer-btn-mobile'
              )}
              aria-label={themeTooltip}
            >
              <span className='w-28px h-28px flex items-center justify-center shrink-0'>
                {theme === 'dark' ? (
                  <SunOne theme='outline' size='18' fill='currentColor' className='block leading-none' />
                ) : (
                  <Moon theme='outline' size='18' fill='currentColor' className='block leading-none' />
                )}
              </span>
            </div>
          </Tooltip>
        )}
      </div>
    </div>
  );
};

type QuotaSummaryViewProps = {
  collapsed: boolean;
  loading: boolean;
  summary: HTHQuotaSummary | null;
  siderTooltipProps: SiderTooltipProps;
  onRefresh: () => void;
};

const QuotaSummaryView: React.FC<QuotaSummaryViewProps> = ({
  collapsed,
  loading,
  summary,
  siderTooltipProps,
  onRefresh,
}) => {
  const { t } = useTranslation();
  if (!summary) {
    return null;
  }

  const totalDisplay = summary.total_available_display || formatQuota(summary.total_available);
  const walletDisplay = summary.wallet.display || formatQuota(summary.wallet.remain_quota);
  const enterprise = summary.subscriptions.find((item) => item.group_key === 'enterprise');
  const personal = summary.subscriptions.find((item) => item.group_key === 'personal');
  const enterpriseDisplay = enterprise?.amount_available_display || formatQuota(enterprise?.amount_available ?? 0);
  const personalDisplay = personal?.amount_available_display || formatQuota(personal?.amount_available ?? 0);
  const tooltip = `${t('common.modelQuota')}: ${totalDisplay}
${t('common.walletQuota')}: ${walletDisplay}
${t('common.enterpriseSubscriptionQuota')}: ${enterpriseDisplay}
${t('common.personalSubscriptionQuota')}: ${personalDisplay}`;

  if (collapsed) {
    return (
      <Tooltip {...siderTooltipProps} content={tooltip} position='right'>
        <div className='mb-6px h-32px flex items-center justify-center text-t-secondary'>
          <Wallet theme='outline' size='16' fill='currentColor' />
        </div>
      </Tooltip>
    );
  }

  return (
    <div className='mx-8px mb-8px rounded-6px bg-fill-1 px-8px py-7px text-12px text-t-secondary'>
      <div className='mb-4px flex items-center justify-between gap-6px'>
        <span className='min-w-0 truncate font-500 text-t-primary'>{t('common.modelQuota')}</span>
        <Button
          size='mini'
          type='text'
          loading={loading}
          icon={<Refresh theme='outline' size='13' fill='currentColor' />}
          onClick={onRefresh}
          aria-label={t('common.refresh')}
        />
      </div>
      <QuotaLine label={t('common.totalAvailableQuota')} value={totalDisplay} />
      <QuotaLine label={t('common.walletQuota')} value={walletDisplay} />
      <QuotaLine label={t('common.enterpriseSubscriptionQuota')} value={enterpriseDisplay} />
      <QuotaLine label={t('common.personalSubscriptionQuota')} value={personalDisplay} />
    </div>
  );
};

const QuotaLine: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className='flex items-center justify-between gap-8px leading-18px'>
    <span className='min-w-0 truncate'>{label}</span>
    <span className='shrink-0 font-500 text-t-primary'>{value}</span>
  </div>
);

function formatQuota(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

export default SiderFooter;
