/**
 * AssistantAvatar — Renders an assistant's avatar with emoji, image, or fallback icon.
 */
import type { AssistantListItem } from './types';
import type { HTHAssistantUpdate } from '@/common/types/hth';
import { Avatar, Badge, Tooltip } from '@arco-design/web-react';
import { Robot } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { isEmoji, resolveAvatarImageSrc } from './assistantUtils';
import ThemedLogo from '@/renderer/components/agent/ThemedLogo';

type AssistantAvatarProps = {
  assistant: AssistantListItem;
  imageFit?: 'contain' | 'cover';
  shape?: 'circle' | 'square';
  size?: number;
  update?: HTHAssistantUpdate;
};

const AssistantAvatar: React.FC<AssistantAvatarProps> = ({
  assistant,
  imageFit = 'cover',
  shape = 'square',
  size = 32,
  update,
}) => {
  const { t } = useTranslation();
  const resolvedAvatar = assistant.avatar?.trim();
  const hasEmojiAvatar = Boolean(resolvedAvatar && isEmoji(resolvedAvatar));
  const avatarImage = resolveAvatarImageSrc(resolvedAvatar);
  const iconSize = Math.floor(size * 0.5);
  const emojiSize = Math.floor(size * 0.6);

  const avatar = (
    <Avatar.Group size={size}>
      <Avatar className='border-none' shape={shape} style={{ backgroundColor: 'var(--color-fill-2)', border: 'none' }}>
        {avatarImage ? (
          <ThemedLogo
            src={avatarImage}
            alt=''
            className={`rounded-inherit ${imageFit === 'contain' ? 'object-contain' : 'object-cover'}`}
            // Arco Avatar forces color:var(--color-white); pin to theme text so
            // the currentColor mask stays visible in light mode too.
            style={{ display: 'block', width: size, height: size, color: 'var(--text-primary)' }}
          />
        ) : hasEmojiAvatar ? (
          <span style={{ fontSize: emojiSize }}>{resolvedAvatar}</span>
        ) : (
          <Robot theme='outline' size={iconSize} />
        )}
      </Avatar>
    </Avatar.Group>
  );

  if (!update?.updateAvailable) return avatar;

  const updateLabel = t('settings.hth.assistantUpdateAvailable', { defaultValue: 'New version available' });
  const tooltip = update.localVersion
    ? t('settings.hth.assistantUpdateVersions', {
        defaultValue: '{{localVersion}} → {{remoteVersion}}. Click Sync Assistants to update.',
        localVersion: update.localVersion,
        remoteVersion: update.remoteVersion,
      })
    : updateLabel;

  return (
    <Tooltip content={tooltip}>
      <span
        className='inline-flex shrink-0'
        role='status'
        aria-label={updateLabel}
        data-testid={`assistant-update-${assistant.id}`}
      >
        <Badge dot count={1} offset={[-1, 1]} dotClassName={size <= 24 ? '!h-6px !w-6px' : '!h-10px !w-10px'}>
          {avatar}
        </Badge>
      </span>
    </Tooltip>
  );
};

export default AssistantAvatar;
