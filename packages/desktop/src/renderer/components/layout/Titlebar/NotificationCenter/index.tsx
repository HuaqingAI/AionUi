/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import AionModal from '@renderer/components/base/AionModal';
import { isElectronDesktop } from '@renderer/utils/platform';
import { Alert, Badge, Button, Empty, Spin } from '@arco-design/web-react';
import { ArrowLeft, ArrowRight, Remind, Close, Mail } from '@icon-park/react';
import React, { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotificationCenter } from './useNotificationCenter';
import styles from './NotificationCenter.module.css';

type NotificationCenterProps = { iconSize: number; strokeWidth?: number };

function DesktopNotificationCenter(props: NotificationCenterProps) {
  const { t, i18n } = useTranslation();
  const center = useNotificationCenter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listPosition = useRef(0);
  const lastSelected = useRef<string | null>(null);
  const formatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language || 'en-US'),
    [i18n.resolvedLanguage, i18n.language]
  );
  const ready = center.snapshot.status === 'ready';
  const loading = center.refreshing || center.snapshot.status === 'idle' || center.snapshot.status === 'loading';
  const count = center.snapshot.unread_count ?? 0;
  const label =
    count > 0 ? t('common.notificationCenter.unreadLabel', { total: count }) : t('common.notificationCenter.title');
  const detail = center.detail;
  const markDisplayed = center.markDisplayed;

  // Reading starts after the detail has committed to the screen, never on list open.
  useEffect(() => {
    if (detail) void markDisplayed(detail);
  }, [detail, markDisplayed]);

  useEffect(() => {
    if (!center.visible || center.selectedId || !listRef.current) return;
    listRef.current.scrollTop = listPosition.current;
    if (lastSelected.current) {
      listRef.current.querySelector<HTMLButtonElement>(`[data-notification-id="${lastSelected.current}"]`)?.focus();
    }
  }, [center.visible, center.selectedId]);

  const select = (id: string) => {
    listPosition.current = listRef.current?.scrollTop ?? 0;
    lastSelected.current = id;
    void center.select(id);
  };
  const retry = () => {
    if (detail && center.error === 'storage_failed') void center.markDisplayed(detail);
    else if (center.selectedId && ready) void center.select(center.selectedId);
    else void center.refresh();
  };
  const error = center.error ?? center.snapshot.error_code ?? 'unavailable';

  return (
    <>
      <Badge count={ready ? count : 0} maxCount={99} className={styles.badge}>
        <Button
          ref={triggerRef}
          type='text'
          className={`app-titlebar__button ${styles.trigger}`}
          aria-label={label}
          title={t('common.notificationCenter.title')}
          aria-haspopup='dialog'
          aria-expanded={center.visible}
          onClick={center.open}
          icon={<Remind theme='outline' size={props.iconSize} fill='currentColor' strokeWidth={props.strokeWidth} />}
        />
      </Badge>
      <AionModal
        visible={center.visible}
        variant='standard'
        size='medium'
        className={styles.dialog}
        footer={null}
        onCancel={center.close}
        unmountOnExit
        afterOpen={() => headingRef.current?.focus()}
        afterClose={() => triggerRef.current?.focus()}
        header={{
          className: styles.header,
          render: () => (
            <div className='flex items-center justify-between gap-12px min-w-0 w-full'>
              <div className='flex items-center gap-8px min-w-0'>
                {center.selectedId && (
                  <Button
                    type='text'
                    icon={<ArrowLeft size={18} />}
                    aria-label={t('common.goBack')}
                    onClick={center.back}
                  />
                )}
                <h2 ref={headingRef} tabIndex={-1} className='text-16px font-600 text-t-primary m-0 truncate'>
                  {t('common.notificationCenter.title')}
                </h2>
              </div>
              <div className='flex items-center gap-8px shrink-0'>
                {!center.selectedId && (
                  <Button
                    type='text'
                    size='small'
                    className='!inline-flex items-center gap-6px'
                    icon={<Mail size={20} className='flex shrink-0' />}
                    disabled={
                      !ready || center.refreshing || count === 0 || center.snapshot.storage_status === 'unavailable'
                    }
                    loading={center.marking}
                    onClick={() => void center.markAllRead()}
                  >
                    <span className='!m-0'>{t('common.notificationCenter.markAllRead')}</span>
                  </Button>
                )}
                <Button type='text' icon={<Close size={18} />} aria-label={t('common.close')} onClick={center.close} />
              </div>
            </div>
          ),
        }}
      >
        {center.snapshot.storage_status === 'recovered' && (
          <Alert type='warning' content={t('common.notificationCenter.storageRecovered')} className='mb-12px' />
        )}
        {center.snapshot.storage_status === 'unavailable' && !center.error && (
          <Alert type='warning' content={t('common.notificationCenter.errors.storage_failed')} className='mb-12px' />
        )}
        {center.selectedId ? (
          <div className={styles.body}>
            {center.detailLoading && <Spin className={styles.loading} aria-label={t('common.loading')} />}
            {detail && (
              <article>
                <h3 className='text-18px text-t-primary font-600 m-0 break-words'>{detail.title}</h3>
                <time className='block mt-8px mb-20px text-12px text-t-tertiary'>
                  {formatter.format(detail.published_at * 1000)}
                </time>
                <div className={styles.content}>{detail.content}</div>
              </article>
            )}
            {center.error && (
              <div role='alert' className='mt-12px'>
                <Alert type='warning' content={t(`common.notificationCenter.errors.${error}`)} />
                <Button className='mt-12px' onClick={retry} loading={center.marking}>
                  {t('common.retry')}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div ref={listRef} className={styles.body}>
            {loading ? (
              <Spin className={styles.loading} aria-label={t('common.loading')} />
            ) : !ready || center.error ? (
              <div role='alert'>
                <Alert type='warning' content={t(`common.notificationCenter.errors.${error}`)} />
                <Button className='mt-12px' onClick={retry}>
                  {t('common.retry')}
                </Button>
              </div>
            ) : center.snapshot.items.length === 0 ? (
              <Empty description={t('common.notificationCenter.empty')} />
            ) : (
              <div className='flex flex-col gap-8px'>
                {center.snapshot.items.map((item) => (
                  <Button
                    key={item.id}
                    type='secondary'
                    className={styles.item}
                    data-notification-id={item.id}
                    onClick={() => select(item.id)}
                    aria-label={`${item.title}, ${t(item.is_read ? 'common.notificationCenter.read' : 'common.notificationCenter.unread')}`}
                  >
                    <Mail size={20} className='shrink-0 text-primary' />
                    <span className='flex-1 min-w-0 text-left'>
                      <span className='flex items-center gap-6px text-12px leading-16px text-t-tertiary'>
                        <span>{t('common.notificationCenter.category')}</span>
                        <time>{formatter.format(item.published_at * 1000)}</time>
                        {!item.is_read && (
                          <Badge
                            status='error'
                            text={t('common.notificationCenter.unread')}
                            className={styles.unread}
                          />
                        )}
                      </span>
                      <span className='block text-14px leading-20px text-t-primary font-500 mt-2px truncate'>
                        {item.title}
                      </span>
                      {item.summary && (
                        <span className='block text-12px leading-16px text-t-secondary mt-2px truncate'>
                          {item.summary}
                        </span>
                      )}
                    </span>
                    <ArrowRight size={16} className='shrink-0 text-t-tertiary' />
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
      </AionModal>
    </>
  );
}

export default function NotificationCenter(props: NotificationCenterProps) {
  if (!isElectronDesktop()) return null;
  return <DesktopNotificationCenter {...props} />;
}
