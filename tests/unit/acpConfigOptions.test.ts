import type { AcpConfigOptionDto, SetConfigOptionResponse } from '@/common/types/platform/acpTypes';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import {
  classifyConfigSetError,
  deriveSelectOption,
  hasObservedValue,
} from '@/renderer/hooks/agent/useAcpConfigOptions';
import { describe, expect, it } from 'vitest';

const options: AcpConfigOptionDto[] = [
  {
    id: 'model',
    category: 'model',
    option_type: 'select',
    current_value: 'gpt-5.5',
    options: [
      { value: 'gpt-5.5', name: 'GPT-5.5' },
      { value: 'gpt-5.4', name: 'GPT-5.4' },
    ],
  },
  {
    id: 'reasoning_effort',
    category: 'thought_level',
    option_type: 'select',
    current_value: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  },
];

describe('ACP config option derivation', () => {
  it('keeps model and thought_level independent', () => {
    const model = deriveSelectOption(options, 'model', ['model']);
    const thought = deriveSelectOption(options, 'thought_level', ['reasoning_effort']);

    expect(model?.currentValue).toBe('gpt-5.5');
    expect(model?.options.map((item) => item.value)).toEqual(['gpt-5.5', 'gpt-5.4']);
    expect(thought?.currentValue).toBe('high');
    expect(thought?.options.map((item) => item.value)).toEqual(['low', 'high']);
  });

  it.each([
    { backend: 'codex', labels: ['Low', 'High'] },
    { backend: 'opencode', labels: ['Low', 'High'] },
  ])('derives display labels for $backend while preserving protocol values', ({ backend, labels }) => {
    const backendOptions = [
      {
        id: 'reasoning_effort',
        category: 'thought_level',
        type: 'select',
        current_value: 'high',
        options: [
          { value: 'low', name: 'low' },
          { value: 'high', name: 'high' },
        ],
      },
    ] as unknown as AcpConfigOptionDto[];

    const thought = deriveSelectOption(backendOptions, 'thought_level', ['reasoning_effort'], backend);

    expect(thought?.currentValue).toBe('high');
    expect(thought?.options.map((item) => item.value)).toEqual(['low', 'high']);
    expect(thought?.options.map((item) => item.label)).toEqual(labels);
  });

  it('accepts only observed set responses with matching current_value', () => {
    const response: SetConfigOptionResponse = {
      confirmation: 'observed',
      config_options: options,
    };

    expect(hasObservedValue(response, 'model', 'gpt-5.5')).toBe(true);
    expect(hasObservedValue(response, 'model', 'gpt-5.4')).toBe(false);
  });

  it('shows only explicit HTH OpenCode efforts in reasoning order without changing the selected value', () => {
    const runtimeOptions: AcpConfigOptionDto[] = [
      {
        ...options[0],
        current_value: 'hth/deepseek-v4.1-flash',
        options: [{ value: 'hth/deepseek-v4.1-flash', name: 'DeepSeek' }],
      },
      {
        ...options[1],
        id: 'effort',
        current_value: 'none',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
          { value: 'max', name: 'Max' },
          { value: 'none', name: 'None' },
          { value: 'default', name: 'Default' },
        ],
      },
    ];
    const thought = deriveSelectOption(runtimeOptions, 'thought_level', ['effort'], 'opencode');

    expect(thought?.options.map((item) => item.value)).toEqual(['none', 'low', 'high', 'max']);
    expect(thought?.currentValue).toBe('none');
    expect(runtimeOptions[1].options.at(-1)?.value).toBe('default');
  });

  it.each(['default', 'none'])(
    'keeps the actual %s OpenCode choice while hiding its extra default menu entry',
    (currentValue) => {
      const runtimeOptions: AcpConfigOptionDto[] = [
        { ...options[0], current_value: 'hth/gpt-5' },
        {
          ...options[1],
          current_value: currentValue,
          options: [
            { value: 'none', name: 'None' },
            { value: 'default', name: 'Default' },
          ],
        },
      ];
      const thought = deriveSelectOption(runtimeOptions, 'thought_level', ['reasoning_effort'], 'opencode');
      expect(thought?.options.map((item) => item.value)).toEqual(['none']);
      expect(thought?.currentValue).toBe(currentValue);
    }
  );

  it.each([
    { backend: 'opencode', model: 'other/gpt-5', efforts: ['low', 'default'] },
    { backend: 'codex', model: 'hth/gpt-5', efforts: ['low', 'default'] },
    { backend: 'opencode', model: 'hth/gpt-5', efforts: ['default'] },
  ])(
    'preserves fallback choices outside an explicit HTH OpenCode effort list: $backend/$model/$efforts',
    ({ backend, model, efforts }) => {
      const runtimeOptions: AcpConfigOptionDto[] = [
        { ...options[0], current_value: model },
        { ...options[1], options: efforts.map((value) => ({ value, name: value })) },
      ];
      expect(
        deriveSelectOption(runtimeOptions, 'thought_level', [], backend)?.options.map((item) => item.value)
      ).toEqual(efforts);
    }
  );

  it('rejects command_ack responses without mutating confirmed state', () => {
    const response: SetConfigOptionResponse = {
      confirmation: 'command_ack',
      config_options: null,
    };

    expect(hasObservedValue(response, 'model', 'gpt-5.5')).toBe(false);
  });

  it('classifies a team runtime Starting conflict as a busy config update', () => {
    const error = new BackendHttpError({
      method: 'PUT',
      path: '/api/teams/team-1/conversations/conv-1/config-options/model',
      status: 409,
      body: {
        success: false,
        error: 'Team member runtime is starting',
        code: 'TEAM_MEMBER_RUNTIME_STARTING',
      },
    });

    expect(classifyConfigSetError(error)).toBe('config_update_in_progress');
  });
});
