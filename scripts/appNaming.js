const PRODUCTION_EXECUTABLE_NAME = 'HQBuddy';
const DEVELOPMENT_EXECUTABLE_NAME = 'HQBuddy-Dev';

function resolveBuildFlavor(env = process.env) {
  const explicitFlavor = String(env.AIONUI_BUILD_FLAVOR || '')
    .trim()
    .toLowerCase();
  if (explicitFlavor === 'dev' || explicitFlavor === 'development') {
    return 'dev';
  }
  if (explicitFlavor === 'prod' || explicitFlavor === 'production') {
    return 'production';
  }
  return env.GITHUB_REF_NAME === 'dev' ? 'dev' : 'production';
}

function resolveExecutableName(env = process.env) {
  return resolveBuildFlavor(env) === 'dev' ? DEVELOPMENT_EXECUTABLE_NAME : PRODUCTION_EXECUTABLE_NAME;
}

module.exports = {
  DEVELOPMENT_EXECUTABLE_NAME,
  PRODUCTION_EXECUTABLE_NAME,
  resolveBuildFlavor,
  resolveExecutableName,
};
