/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';
import { getSkillDisplayDescription } from '@/renderer/pages/settings/SkillsSettings/skillDescriptions';
import enSettings from '@/renderer/services/i18n/locales/en-US/settings.json';
import zhSettings from '@/renderer/services/i18n/locales/zh-CN/settings.json';
import zhTWSettings from '@/renderer/services/i18n/locales/zh-TW/settings.json';

const createSkillTranslator = async (language = 'zh-CN') => {
  const i18n = createInstance();
  await i18n.init({
    lng: language,
    fallbackLng: 'en-US',
    resources: {
      'en-US': { translation: { settings: enSettings } },
      'zh-CN': { translation: { settings: zhSettings } },
      'zh-TW': { translation: { settings: zhTWSettings } },
    },
  });
  return i18n;
};

describe('official skill display descriptions', () => {
  it.each(['officecli-docx', 'cron'] as const)(
    'shows the Chinese display description for %s without changing the skill metadata',
    async (name) => {
      const i18n = await createSkillTranslator();
      const skill = Object.freeze({ name, description: 'Original English skill metadata.', source: 'builtin' });

      const description = getSkillDisplayDescription(skill, i18n.t);

      expect(description).toBe(zhSettings.skillsHub.builtinDescriptions[name]);
      expect(description).toMatch(/\p{Script=Han}/u);
      expect(skill.description).toBe('Original English skill metadata.');
    }
  );

  it('falls back to the original description for a builtin skill without display copy', async () => {
    const i18n = await createSkillTranslator();
    const skill = { name: 'new-builtin-skill', description: 'Description from a newer release.', source: 'builtin' };

    expect(getSkillDisplayDescription(skill, i18n.t)).toBe('Description from a newer release.');
  });

  it.each(['custom', 'extension', 'cron', undefined])(
    'preserves the original description for a same-name skill from source %s',
    async (source) => {
      const i18n = await createSkillTranslator();
      const skill = { name: 'officecli-docx', description: 'User-provided description.', source };

      expect(getSkillDisplayDescription(skill, i18n.t)).toBe('User-provided description.');
    }
  );

  it('uses the current interface language when it changes', async () => {
    const i18n = await createSkillTranslator();
    const skill = { name: 'officecli-docx', description: 'Original metadata.', source: 'builtin' };
    expect(getSkillDisplayDescription(skill, i18n.t)).toBe(zhSettings.skillsHub.builtinDescriptions['officecli-docx']);

    await i18n.changeLanguage('en-US');
    expect(getSkillDisplayDescription(skill, i18n.t)).toBe(enSettings.skillsHub.builtinDescriptions['officecli-docx']);

    await i18n.changeLanguage('zh-TW');
    expect(getSkillDisplayDescription(skill, i18n.t)).toBe(
      zhTWSettings.skillsHub.builtinDescriptions['officecli-docx']
    );
  });
});
