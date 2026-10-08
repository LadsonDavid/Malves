const { existsSync } = require("node:fs");
const path = require("node:path");

// Malves' calls need Firebase: google-services.json (from your Firebase project,
// kept out of git; the APK workflow writes it from the GOOGLE_SERVICES_JSON
// secret). Without it the app builds the same, just without calls.
module.exports = ({ config }) =>
  existsSync(path.join(__dirname, "google-services.json"))
    ? { ...config, android: { ...config.android, googleServicesFile: "./google-services.json" } }
    : config;
