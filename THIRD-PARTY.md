# Third-party code

Code in this repository that was copied from, or closely follows, other
projects. Each entry is also listed in the dissertation's declaration of
original work. Dependencies installed from npm keep their own licence files and
are not copied into this repository.

## Agent Client Protocol TypeScript SDK

- Source: https://github.com/agentclientprotocol/typescript-sdk (version 1.5.1,
  `dist/examples/client.js` and `dist/examples/agent.js`)
- Licence: Apache-2.0, Copyright Zed Industries
- Used in:
  - `packages/runner/src/adapters/acp/host.ts` — the client connection sequence
    (spawn, `ndJsonStream`, `initialize`, `buildSession`, the `nextUpdate()` loop)
    follows the SDK's example client. The permission, confinement, cancellation
    and process-group handling are original.
  - `packages/runner/src/demo-agent.ts` — the shape of the agent (handlers for
    `initialize`, `session/new`, `session/prompt`, and the permission request)
    follows the SDK's example agent. No code was copied verbatim.

## Expo project and module templates

- Source: `create-expo-app` (blank-typescript template, SDK 57) and
  `create-expo-module --local`, https://github.com/expo/expo
- Licence: MIT, Copyright 650 Industries, Inc. (Expo)
- Used in:
  - `packages/app/assets/*.png` — the template's placeholder icons, unchanged.
  - `packages/app/modules/malves-notify/android/build.gradle` and
    `expo-module.config.json` — the generated module scaffolding; the
    dependencies block and all Kotlin code are original.

## Libraries whose licence differs from Apache-2.0

Used unmodified as npm dependencies, not copied into this repository:

- `web-push` (MPL-2.0) — builds the encrypted Web Push request in
  `packages/runner/src/adapters/push/webpush.ts`. MPL-2.0 is file-level
  copyleft; no MPL files are modified or included here.
- `tweetnacl` (Unlicense / public domain), `ws` (MIT), `better-sqlite3` (MIT),
  `zod` (MIT), `expo-unified-push` (MIT).
- `@playwright/mcp` (Apache-2.0) and `@modelcontextprotocol/sdk` (MIT) — the
  browser gate runs Playwright MCP as a child process and proxies its tools.
