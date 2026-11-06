# Codex desktop integration: current evidence

The owner's first priority is continuing an existing Codex desktop conversation,
answering its native questions, and reviewing its edits from Malves on Android.
CLI execution and replaying desktop history into another process do not satisfy
this requirement.

## Observed on Windows, November 6, 2026

- Desktop package: `OpenAI.Codex 26.1029.7803.0`.
- Bundled executable: `codex-cli 0.166.0-alpha.6`.
- The desktop's app-server process is running. Its observed flags do not expose
  a local `--listen` endpoint.
- The executable advertises `app-server proxy`, described by its own help as
  proxying stdio to the running app-server control socket.
- A read-only attempt to initialize through that proxy failed before the
  handshake: the default control socket refused the connection (Windows 10061).
- `app-server daemon version` failed against the same socket. No daemon was
  started or restarted, and no settings or credentials were changed.
- Android platform-tools/adb is unavailable in PATH and the usual local SDK
  location; a real-phone acceptance test was not performed.

This establishes that the probed shared endpoint is unavailable on this
installation. It does not establish that every supported way to connect is
unavailable. A private desktop IPC protocol is not a substitute for a supported
integration contract.

## Supported queue route verified on desktop

The installed bundle also advertises `codex queue --thread <UUID> --message
<TEXT>`. Official documentation identifies this as a supported way to queue a
message for an existing conversation. This is a control command, not a new CLI
agent session. `--resume` is a separate option and must not be added implicitly.
Queue acceptance alone does not prove that the live desktop consumes the message
or that native approval requests can be answered through this route.

An owner-selected existing conversation received the authorized no-tools/no-files
test and replied `MALVES_DESKTOP_OK`. A second test passed through Malves' real
encrypted LinkClient/LinkServer, Sessions dispatcher and configured native queue
adapter. The same desktop conversation again replied `MALVES_DESKTOP_OK`; the
runner created zero agent tasks. Neither desktop turn used tools. Opening the
chat was needed to consume the first queued message; keep the target chat open.
This was a local client test, not an Android acceptance test.

Set `MALVES_CODEX_DESKTOP_BIN` to the absolute installed Codex executable to opt
in. Startup checks its queue help before advertising the capability. The adapter
never passes `--resume`, persists command receipts to prevent duplicate delivery,
and blocks automatic retry after uncertain delivery. A receipt means queued,
not answered. Refresh the transcript to inspect the actual reply.
Native approval and edit-review controls remain disabled independently.
The owner chose supported native connections rather than handover UI automation.

## Changes that are implemented

Further implementation and validation are tracked in
[the nine-operation status](mobile-desktop-progress.md). The shared-socket probe
was repeated and still refused the connection. Recorded native operations can
now be inspected from the saved rollout; that does not establish a live native
approval connection.

- Sessions defaults to Desktop app. A desktop request cannot fall back to
  resuming or launching a CLI agent. It has a distinct wire command so older
  runners reject it rather than ignore the requested target.
- Desktop transcripts can be refreshed, with a direct route to the computer
  screen for native approvals and edit review. That route is human screen
  control, not structured native Codex integration.
- Cursor's existing desktop bridge remains a separate supported-by-the-current-
  adapter route. Its transcript stays open after sending and refreshes while the
  app is active. That bridge was not discovered on this machine.
- Shared runner tasks publish batched text and tool status/results into the
  event log, so reconnection preserves them. These runner events do not capture
  native desktop approvals.
- The conversation screen can now request a read-only tracked Git review of
  its workspace. Real Git tests cover staged/unstaged edits, scope boundaries,
  sensitive path exclusion, unchanged index, literal filenames, bounded output,
  clean/non-Git folders and unborn repositories. An encrypted-link test verifies
  routing without creating an agent task. This is a workspace snapshot, not a
  native Codex proposed-edit approval; Android verification is outstanding.

## Acceptance gate for a real Codex desktop connector

1. Discover and connect to the backend actually used by the desktop through a
   supported, version-matched interface. Do not silently start another backend.
2. Read the target conversation and prove its identity. Identify its active turn
   and pending request ownership before attempting any action.
3. Continue that same conversation; verify the message in the desktop app.
4. Deliver a native question to the phone, route its answer to the exact live
   request, and verify first-answer-wins when the desktop answers concurrently.
5. Show actual proposed file changes and their outcome. Approval of an agent
   action and approval of a git commit are separate decisions.
6. Disconnect/reconnect and stop the turn without duplicate messages, stale
   approvals, or false success. Silence must never approve an action.

Native Codex desktop control remains incomplete until this gate is met. If the
installed desktop cannot expose a supported shared connection, evaluate its
official Remote Control setup or explicitly authorized handover UI control;
do not describe a newly spawned CLI as desktop integration.

## References

- [Official App Server protocol](https://developers.openai.com/codex/app-server):
  transports, initialization, loaded threads, turns and approval requests.
- [Official remote connections](https://learn.chatgpt.com/docs/remote-connections):
  vendor-supported remote access, distinct from an embedded Malves connector.
- [Official queue command](https://learn.chatgpt.com/docs/developer-commands#codex-queue):
  queueing to an existing conversation, with optional explicit resume.
- Local executable help from the installed desktop bundle is the version-specific
  evidence for the proxy experiment above.
