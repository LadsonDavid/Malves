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
    (spawn, `ndJsonStream`, `initialize`, opening a session, prompting)
    follows the SDK's example client. The permission, confinement, cancellation
    and process-group handling are original.
  - `packages/runner/src/demo-agent.ts` — the shape of the agent (handlers for
    `initialize`, `session/new`, `session/prompt`, and the permission request)
    follows the SDK's example agent. No code was copied verbatim.

## Expo blank TypeScript template

- Source: `create-expo-app` 5.0.0, template `blank-typescript` (Expo SDK 57)
- Licence: MIT, Copyright (c) 2015-present 650 Industries, Inc. (aka Expo)
- Used in: `packages/app` — the starting scaffold (`app.json`, `tsconfig.json`,
  `index.ts`, the `assets/` icons). The app's own code (`App.tsx`, `src/`)
  replaced the template's placeholder screen and is original.

## Design inspiration, no code copied

- **Happy** (https://github.com/slopus/happy, MIT): the phone ↔ desktop
  encryption design — phone-held keys, NaCl-sealed payloads, a server that only
  sees ciphertext. `packages/protocol/src/crypto.ts` and `client.ts` are our own
  code. Cite as design inspiration in the dissertation.
