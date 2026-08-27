import { describe, expect, it } from 'vitest';
import { appendModelMultiplier, calculateModelPricing } from '@/common/modelPricing';

describe('model pricing calculation', () => {
  it('uses the lowest weighted token cost as x1 and combines input/output prices', () => {
    const result = calculateModelPricing(
      ['cheap', 'expensive'],
      [
        { model_name: 'cheap', quota_type: 0, model_ratio: 1, completion_ratio: 1 },
        { model_name: 'expensive', quota_type: 0, model_ratio: 5, completion_ratio: 1 },
      ],
      { default: 1 }
    );

    expect(result.get('cheap')).toMatchObject({
      inputUsdPer1M: 2,
      outputUsdPer1M: 2,
      effectiveUsdPer1M: 2,
      multiplier: '1',
    });
    expect(result.get('expensive')?.multiplier).toBe('5');
    expect(appendModelMultiplier('CHEAP', result.get('cheap'))).toBe('CHEAP x1');
  });

  it('skips per-request, dynamic, unmatched, and invalid pricing entries', () => {
    const result = calculateModelPricing(
      ['per-request', 'dynamic', 'unknown', 'invalid', 'valid'],
      [
        { model_name: 'per-request', quota_type: 1, model_price: 0.01 },
        { model_name: 'dynamic', quota_type: 0, model_ratio: 2, completion_ratio: 1, billing_mode: 'tiered_expr' },
        { model_name: 'invalid', quota_type: 0, model_ratio: Number.NaN, completion_ratio: 1 },
        { model_name: 'valid', quota_type: 0, model_ratio: 2, completion_ratio: 1 },
      ],
      { default: 1 }
    );

    expect([...result.keys()]).toEqual(['valid']);
    expect(appendModelMultiplier('PER-REQUEST')).toBe('PER-REQUEST');
  });

  it('falls back to the first valid group ratio when default is unavailable', () => {
    const result = calculateModelPricing(
      ['model'],
      [{ model_name: 'model', quota_type: 0, model_ratio: 1, completion_ratio: 2 }],
      { premium: 3, default: 0 }
    );

    expect(result.get('model')?.inputUsdPer1M).toBe(6);
    expect(result.get('model')?.outputUsdPer1M).toBe(12);
  });
});
