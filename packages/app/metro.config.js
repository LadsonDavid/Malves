// Expo's default Metro config detects the pnpm monorepo and watches the
// shared @malves/protocol package.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
