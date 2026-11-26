/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type ModelFamily = 'deepseek' | 'qwen' | 'glm' | 'gpt';
export type ModelReasoningRule = {
  match_type: 'family' | 'model';
  match_value: string;
  efforts: ReasoningEffort[];
};
export type ModelReasoningPolicy = {
  schema_version: 1;
  scope: 'global';
  revision: string;
  default_efforts: ReasoningEffort[];
  rules: ModelReasoningRule[];
};
export type HTHRuntimeModelChoicesRequest = { assistant_id: string };
export type HTHRuntimeModelChoices = {
  cli_type: 'opencode' | 'codex';
  policy_revision: string;
  default_model_id?: string;
  models: Array<{
    id: string;
    gateway_model_id: string;
    label: string;
    efforts: ReasoningEffort[];
    default_effort: ReasoningEffort;
  }>;
};

export const DEFAULT_MODEL_REASONING_POLICY: ModelReasoningPolicy = {
  schema_version: 1,
  scope: 'global',
  revision: 'legacy-default',
  default_efforts: ['low', 'medium', 'high'],
  rules: [],
};

/** Detect a family without changing the gateway's complete model ID. */
export function detectModelFamily(id: string): ModelFamily | undefined {
  const name = id.trim().split('/').at(-1)?.toLowerCase() ?? '';
  const match = /^(deepseek|qwen|glm|gpt)(?:$|[-_.]|[0-9])/.exec(name);
  return match?.[1] as ModelFamily | undefined;
}

/** Resolve one complete override, preserving exact model precedence. */
export function resolveModelReasoning(
  id: string,
  policy: ModelReasoningPolicy
): { efforts: ReasoningEffort[]; default_effort: ReasoningEffort } {
  const family = detectModelFamily(id);
  const rule =
    policy.rules.find((item) => item.match_type === 'model' && item.match_value === id.trim()) ??
    policy.rules.find((item) => item.match_type === 'family' && item.match_value === family);
  const efforts = [...(rule?.efforts ?? policy.default_efforts)];
  return { efforts, default_effort: efforts.includes('high') ? 'high' : efforts[efforts.length - 1] };
}

/** Validate untrusted configuration before it can affect either CLI. */
export function parseModelReasoningPolicy(input: unknown): ModelReasoningPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('reasoningPolicyInvalid');
  const policy = input as Record<string, unknown>;
  if (
    policy.schema_version !== 1 ||
    policy.scope !== 'global' ||
    typeof policy.revision !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(policy.revision) ||
    !Array.isArray(policy.default_efforts) ||
    policy.default_efforts.join(',') !== 'low,medium,high' ||
    !Array.isArray(policy.rules) ||
    policy.rules.length > 1000
  ) {
    throw new Error('reasoningPolicyInvalid');
  }
  const seen = new Set<string>();
  const rules: ModelReasoningRule[] = [];
  for (const value of policy.rules) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reasoningPolicyInvalid');
    const rule = value as Record<string, unknown>;
    if (
      (rule.match_type !== 'family' && rule.match_type !== 'model') ||
      typeof rule.match_value !== 'string' ||
      !rule.match_value ||
      rule.match_value !== rule.match_value.trim() ||
      [...rule.match_value].length > 255 ||
      [...rule.match_value].some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point < 32 || point === 127 || (point >= 0xd800 && point <= 0xdfff);
      }) ||
      !Array.isArray(rule.efforts) ||
      rule.efforts.length === 0 ||
      rule.efforts.length > REASONING_EFFORTS.length ||
      rule.efforts.some((effort) => !REASONING_EFFORTS.includes(effort as ReasoningEffort))
    ) {
      throw new Error('reasoningPolicyInvalid');
    }
    if (rule.match_type === 'family' && !['deepseek', 'qwen', 'glm', 'gpt'].includes(rule.match_value)) {
      throw new Error('reasoningPolicyInvalid');
    }
    const key = `${rule.match_type}:${rule.match_value}`;
    if (seen.has(key)) throw new Error('reasoningPolicyInvalid');
    seen.add(key);
    const efforts = REASONING_EFFORTS.filter((effort) => (rule.efforts as unknown[]).includes(effort));
    if (efforts.length !== rule.efforts.length) throw new Error('reasoningPolicyInvalid');
    rules.push({ match_type: rule.match_type, match_value: rule.match_value, efforts });
  }
  return {
    schema_version: 1,
    scope: 'global',
    revision: policy.revision,
    default_efforts: ['low', 'medium', 'high'],
    rules,
  };
}
