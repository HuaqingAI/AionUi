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
  return 'production';
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
