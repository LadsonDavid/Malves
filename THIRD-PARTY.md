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

## Heroicons (through react-native-heroicons)

- Source: https://github.com/tailwindlabs/heroicons, packaged for React Native
  by https://github.com/ecklf/react-native-heroicons
- Licence: MIT, Copyright (c) Tailwind Labs, Inc. / Florian Eckl
- Used in: `packages/app/src/icons.tsx` (the app's only icon import point), as
  a dependency. No icon code is copied into this repository.

## Geist, Geist Mono and Fraunces fonts (through @expo-google-fonts)

- Geist and Geist Mono: Vercel, SIL Open Font License 1.1.
- Fraunces: Undercase Type, SIL Open Font License 1.1.
- Used in: `packages/app` (loaded in `App.tsx`), as dependencies.

## Malveon blueprint design system

- Source: the owner's own Malveon project (`DESIGN.md`, the `@malveon/blueprint`
  tokens). Its colour tokens, type roles and component rules are applied to
  the phone app; see `DESIGN.md` here. Own work, not third-party, listed for
  the dissertation's record.

## nut.js (community fork)

- Source: https://github.com/nut-tree/nut.js, packaged as `@nut-tree-fork/nut-js`
  4.2.6 on npm (the original package left the public registry)
- Licence: Apache-2.0
- Used in: `packages/runner/src/adapters/assistant/desktop.ts`, as a
  dependency, for handover mode's mouse, keyboard and screenshots. No code copied.
