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
