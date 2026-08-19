import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveBuildFlavor, resolveExecutableName } = require('../../../scripts/appNaming.js') as {
  resolveBuildFlavor: (env?: NodeJS.ProcessEnv) => string;
  resolveExecutableName: (env?: NodeJS.ProcessEnv) => string;
};

describe('packaged filesystem naming', () => {
  it('uses HQBuddy for production builds by default', () => {
    expect(resolveBuildFlavor({})).toBe('production');
    expect(resolveExecutableName({})).toBe('HQBuddy');
  });

  it('uses HQBuddy-Dev for explicit development builds', () => {
    expect(resolveBuildFlavor({ AIONUI_BUILD_FLAVOR: 'dev' })).toBe('dev');
    expect(resolveExecutableName({ AIONUI_BUILD_FLAVOR: 'dev' })).toBe('HQBuddy-Dev');
  });

  it('keeps builds production by default even on the dev branch', () => {
    expect(resolveExecutableName({ GITHUB_REF_NAME: 'dev' })).toBe('HQBuddy');
    expect(resolveExecutableName({ AIONUI_BUILD_FLAVOR: 'production', GITHUB_REF_NAME: 'dev' })).toBe('HQBuddy');
  });
});
