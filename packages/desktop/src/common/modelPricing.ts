/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type ModelPricingSource = {
  model_name?: unknown;
  quota_type?: unknown;
  model_ratio?: unknown;
  completion_ratio?: unknown;
  billing_mode?: unknown;
  billing_expr?: unknown;
};

export type ModelPricingSnapshot = {
  data: unknown[];
  groupRatio: Record<string, unknown>;
  pricingGroup?: string;
  pricingVersion?: string;
};

export type ModelPricingDisplay = {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  effectiveUsdPer1M: number;
  multiplier: string;
};

const INPUT_WEIGHT = 0.8;
const OUTPUT_WEIGHT = 0.2;

function finitePositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function selectGroupRatio(groupRatio: Record<string, unknown>, pricingGroup?: string): number | null {
  const preferredRatio = pricingGroup ? finitePositiveNumber(groupRatio[pricingGroup]) : null;
  if (preferredRatio !== null) return preferredRatio;

  const defaultRatio = finitePositiveNumber(groupRatio.default);
  if (defaultRatio !== null) return defaultRatio;

  for (const group of Object.keys(groupRatio).toSorted()) {
    const ratio = finitePositiveNumber(groupRatio[group]);
    if (ratio !== null) return ratio;
  }

  return null;
}

function formatMultiplier(value: number): string {
  const normalized = Math.max(1, value);
  const rounded = Math.round(normalized * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(/0+$/, '');
}

function formatUsd(value: number): string {
  const rounded = Math.round(value * 10_000) / 10_000;
  const [integer, decimals] = rounded.toFixed(4).split('.');
  return `${integer}.${(decimals || '').replace(/0+$/, '').padEnd(2, '0')}`;
}

type DynamicTier = {
  label: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
};

const DYNAMIC_PRICE_NUMBER = '[+]?\\d*\\.?\\d+(?:[eE][+-]?\\d+)?';

function extractDynamicPrice(body: string, variable: 'p' | 'c'): number {
  const directPattern = new RegExp(`\\b${variable}\\b\\s*\\*\\s*(${DYNAMIC_PRICE_NUMBER})`, 'g');
  const reversePattern = new RegExp(`(${DYNAMIC_PRICE_NUMBER})\\s*\\*\\s*\\b${variable}\\b`, 'g');
  let value = 0;
  let matched = false;

  for (const match of body.matchAll(directPattern)) {
    value += Number(match[1]);
    matched = true;
  }
  for (const match of body.matchAll(reversePattern)) {
    value += Number(match[1]);
    matched = true;
  }

  if (matched) return value;
  if (
    new RegExp(`\\b${variable}\\b\\s*\\*`).test(body) ||
    new RegExp(`\\*\\s*\\b${variable}\\b`).test(body)
  ) {
    return Number.NaN;
  }
  return new RegExp(`\\b${variable}\\b`).test(body) ? 1 : 0;
}

function parseDynamicTiers(expression: string): DynamicTier[] {
  const tiers: DynamicTier[] = [];
  const tierStart = /tier\s*\(\s*"([^"]*)"\s*,/g;
  let match: RegExpExecArray | null;

  while ((match = tierStart.exec(expression)) !== null) {
    const bodyStart = tierStart.lastIndex;
    let depth = 1;
    let quote = false;
    let escaped = false;
    let bodyEnd = bodyStart;

    for (; bodyEnd < expression.length; bodyEnd += 1) {
      const char = expression[bodyEnd];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          quote = false;
        }
        continue;
      }
      if (char === '"') {
        quote = true;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;

    const body = expression.slice(bodyStart, bodyEnd);
    const inputUsdPer1M = extractDynamicPrice(body, 'p');
    const outputUsdPer1M = extractDynamicPrice(body, 'c');
    if (
      !Number.isFinite(inputUsdPer1M) ||
      !Number.isFinite(outputUsdPer1M) ||
      inputUsdPer1M < 0 ||
      outputUsdPer1M < 0 ||
      (inputUsdPer1M === 0 && outputUsdPer1M === 0)
    ) {
      continue;
    }
    tiers.push({ label: match[1], inputUsdPer1M, outputUsdPer1M });
  }

  return tiers;
}

function selectDynamicTier(expression: string): DynamicTier | null {
  const tiers = parseDynamicTiers(expression);
  if (tiers.length === 0) return null;
  const defaultTier = tiers.find((tier) => /^(base|default|standard)$/i.test(tier.label.trim()));
  return defaultTier || tiers[0];
}

/** Calculate weighted token costs and relative multipliers for runtime model IDs. */
export function calculateModelPricing(
  modelIds: string[],
  pricingSources: unknown[],
  groupRatio: Record<string, unknown> = {},
  pricingGroup?: string
): Map<string, ModelPricingDisplay> {
  const selectedGroupRatio = selectGroupRatio(groupRatio, pricingGroup);
  if (selectedGroupRatio === null) return new Map();
  const byModel = new Map<string, ModelPricingSource>();
  for (const source of pricingSources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const item = source as ModelPricingSource;
    const modelName = typeof item.model_name === 'string' ? item.model_name.trim() : '';
    if (modelName && !byModel.has(modelName)) byModel.set(modelName, item);
  }

  const costs = new Map<string, Omit<ModelPricingDisplay, 'multiplier'>>();
  for (const modelId of modelIds) {
    const source = byModel.get(modelId);
    if (!source || source.quota_type !== 0) continue;

    const billingMode = typeof source.billing_mode === 'string' ? source.billing_mode.trim().toLowerCase() : '';
    const dynamicTier =
      billingMode === 'tiered_expr' && typeof source.billing_expr === 'string'
        ? selectDynamicTier(source.billing_expr)
        : null;
    if (billingMode === 'tiered_expr' && !dynamicTier) continue;

    let inputUsdPer1M: number;
    let outputUsdPer1M: number;
    if (dynamicTier) {
      inputUsdPer1M = dynamicTier.inputUsdPer1M * selectedGroupRatio;
      outputUsdPer1M = dynamicTier.outputUsdPer1M * selectedGroupRatio;
    } else {
      const modelRatio = finitePositiveNumber(source.model_ratio);
      const completionRatio = finiteNonNegativeNumber(source.completion_ratio);
      if (modelRatio === null || completionRatio === null) continue;
      inputUsdPer1M = modelRatio * 2 * selectedGroupRatio;
      outputUsdPer1M = inputUsdPer1M * completionRatio;
    }
    const effectiveUsdPer1M = inputUsdPer1M * INPUT_WEIGHT + outputUsdPer1M * OUTPUT_WEIGHT;
    if (!Number.isFinite(effectiveUsdPer1M) || effectiveUsdPer1M <= 0) continue;
    costs.set(modelId, { inputUsdPer1M, outputUsdPer1M, effectiveUsdPer1M });
  }

  const referenceCost = Math.min(...[...costs.values()].map((item) => item.effectiveUsdPer1M));
  if (!Number.isFinite(referenceCost) || referenceCost <= 0) return new Map();

  return new Map(
    [...costs.entries()].map(([modelId, cost]) => [
      modelId,
      { ...cost, multiplier: formatMultiplier(cost.effectiveUsdPer1M / referenceCost) },
    ])
  );
}

/** Append a computed multiplier to a user-facing model label when available. */
export function appendModelMultiplier(label: string, pricing?: ModelPricingDisplay): string {
  return pricing ? `${label} x${pricing.multiplier}` : label;
}

/** Format the token pricing summary rendered by the existing model option tooltip. */
export function formatModelPricingDescription(pricing?: ModelPricingDisplay): string | undefined {
  if (!pricing) return undefined;
  return [
    `输入 $${formatUsd(pricing.inputUsdPer1M)} / 百万 Token`,
    `输出 $${formatUsd(pricing.outputUsdPer1M)} / 百万 Token`,
  ].join('\n');
}
