/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TFunction } from 'i18next';

type SkillDescription = {
  name: string;
  description?: string;
  source?: string;
};

/** Localize built-in skill descriptions for display without changing the skill metadata. */
export const getSkillDisplayDescription = (skill: SkillDescription, t: TFunction): string => {
  const description = skill.description ?? '';
  if (skill.source !== 'builtin') return description;
  return t(`settings.skillsHub.builtinDescriptions.${skill.name}`, { defaultValue: description });
};
