/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export const GUID_SESSION_EXCLUDED_AUTO_INJECT_SKILL_IDS = ['aionui-config'] as const;

export type GuidSessionSkill = {
  name: string;
  description: string;
  isAuto: boolean;
};

const getExcludedGuidSessionSkillIdSet = (): Set<string> => new Set(GUID_SESSION_EXCLUDED_AUTO_INJECT_SKILL_IDS);

export const filterGuidSessionSkills = (skills: GuidSessionSkill[]): GuidSessionSkill[] => {
  const excludedSkillIds = getExcludedGuidSessionSkillIdSet();
  return skills.filter((skill) => !excludedSkillIds.has(skill.name));
};

export const filterGuidSessionSkillIds = (skillIds: string[] | undefined): string[] | undefined => {
  if (!skillIds) return undefined;

  const excludedSkillIds = getExcludedGuidSessionSkillIdSet();
  return skillIds.filter((skillId) => !excludedSkillIds.has(skillId));
};

export const buildGuidSessionExcludedAutoInjectSkills = (disabledBuiltinSkills: string[] | undefined): string[] => {
  const excludedSkillIds = new Set(disabledBuiltinSkills ?? []);
  GUID_SESSION_EXCLUDED_AUTO_INJECT_SKILL_IDS.forEach((skillId) => excludedSkillIds.add(skillId));
  return [...excludedSkillIds];
};
