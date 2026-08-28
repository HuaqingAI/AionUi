import { describe, expect, it } from 'vitest';

import { appendModelMultiplier, calculateModelPricing, formatModelPricingDescription } from '@/common/modelPricing';

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
    expect(formatModelPricingDescription(result.get('cheap'))).toBe('输入 $2.00 / 百万 Token\n输出 $2.00 / 百万 Token');
  });

  it('uses the default dynamic tier and compares it with fixed token models', () => {
    const result = calculateModelPricing(
      ['fixed', 'dynamic'],
      [
        { model_name: 'fixed', quota_type: 0, model_ratio: 1, completion_ratio: 1 },
        {
          model_name: 'dynamic',
          quota_type: 0,
          billing_mode: 'tiered_expr',
          billing_expr: 'len <= 200000 ? tier("standard", p * 3 + c * 15) : tier("long_context", p * 6 + c * 22.5)',
        },
      ],
      { default: 1 }
    );

    expect(result.get('fixed')?.multiplier).toBe('1');
    expect(result.get('dynamic')?.multiplier).toBe('2.7');
    expect(result.get('dynamic') && formatModelPricingDescription(result.get('dynamic'))).toBe(
      '输入 $3.00 / 百万 Token\n输出 $15.00 / 百万 Token'
    );
  });

  it('skips per-request, unparseable, unmatched, and invalid pricing entries', () => {
    const result = calculateModelPricing(
      ['per-request', 'dynamic', 'unknown', 'invalid', 'valid'],
      [
        { model_name: 'per-request', quota_type: 1, model_price: 0.01 },
        { model_name: 'dynamic', quota_type: 0, billing_mode: 'tiered_expr', billing_expr: 'param("tier")' },
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

  it('uses the pricing group ratio when the server identifies one', () => {
    const result = calculateModelPricing(
      ['deepseek-v4-flash'],
      [
        {
          model_name: 'deepseek-v4-flash',
          quota_type: 0,
          billing_mode: 'tiered_expr',
          billing_expr: 'tier("base", p * 3 + c * 3)',
        },
      ],
      { default: 1, hthbuddy: 2 },
      'hthbuddy'
    );

    expect(result.get('deepseek-v4-flash')).toMatchObject({ inputUsdPer1M: 6, outputUsdPer1M: 6 });
  });

  it('accepts implicit and reversed prompt/completion coefficients', () => {
    const result = calculateModelPricing(
      ['implicit', 'reversed'],
      [
        {
          model_name: 'implicit',
          quota_type: 0,
          billing_mode: 'tiered_expr',
          billing_expr: 'tier("base", p + c * 4)',
        },
        {
          model_name: 'reversed',
          quota_type: 0,
          billing_mode: 'tiered_expr',
          billing_expr: 'tier("base", 2 * p + 8 * c)',
        },
      ],
      { default: 1 }
    );

    expect(result.get('implicit')).toMatchObject({ inputUsdPer1M: 1, outputUsdPer1M: 4, multiplier: '1' });
    expect(result.get('reversed')).toMatchObject({ inputUsdPer1M: 2, outputUsdPer1M: 8, multiplier: '2' });
  });
});
