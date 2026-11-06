# Mobile desktop implementation — November 6, 2026

The first target is an existing Codex desktop chat. Native queue messaging was
verified in the owner's selected chat through Malves' encrypted local client:
the same chat replied `MALVES_DESKTOP_OK`, with zero runner agent tasks.
Android acceptance remains outstanding. Native approvals and proposed-edit
accept/reject remain disabled: the running desktop has no reachable supported
shared control socket. A new backend or CLI is not a substitute.

## Immediate conversation work

- Codex/Cursor transcripts refresh every three seconds while the phone is
  active and immediately on foreground/reconnect. Reads do not overlap.
- Codex rollout discovery reads bounded headers; polling reads at most a 2 MB
  tail and caches unchanged transcripts. It does not stream unpersisted tokens.
- Queue receipts and uncertainty remain visible. New receipts survive runner
  restarts and are retrievable by conversation; they never claim a reply.
- Tool output expands per operation, with consecutive completed reads/searches
  grouped together. Codex saved tool calls/results are readable as recorded
  operations, with their saved turn state; neither is verified live status.
  Tracked workspace patches expand per file,
  showing before/after as unified `-`/`+` lines. This is not native edit approval.

## The nine requested operations

| Operation | Implemented now | Remaining |
|---|---|---|
| 1. Live coding conversation | Logged runner text/tool events, foreground desktop transcript polling and bounded Codex saved tool-call/result inspection | Unpersisted native tokens, actionable approvals and verified runtime state still require a shared native endpoint |
| 2. Readable command/change cards | Expandable runner/native recorded operations, grouped routine reads/searches and per-file workspace diffs | Native proposed-edit approval events require the shared endpoint |
| 3. Questions inbox and typed answers | Work → Questions; text only for explicitly declared runner clarification choices; first answer wins; silence stops | Native Codex question delivery/answering; production agent adapters must explicitly support typed clarification |
| 4. Continuity and recovery | Event replay, durable Codex delivery receipts, human ownership persisted before control changes and restored before task producers, fresh-client recorded-operation recovery tested | Physical phone restart/reconnect acceptance and native pending-request recovery |
| 5. Honest progress/failure | Disconnected snapshot, last transcript check, no-update warning, queued versus answered distinction | Verified native running/waiting/failed state requires native event access |
| 6. Take/return control | Stops runner tasks, cancels tracked handover command process trees, blocks new/background input and persists ownership across restart; returning invalidates pending actions | Native desktop agents must still be paused in their own app; unrelated or already-detached processes are not stopped |
| 7. Fresh desktop references | Screenshot references plus an opt-in Agent Desktop protocol-2.6 adapter: exact app/window, qualified refs, complete observations, duplicate/sensitive target refusal, 30-second expiry | Install/configure the separate native provider and verify actual Windows app behavior during explicit handover |
| 8. Verification and retry safety | Preserves provider delivery/retry dispositions and distinguishes verified postconditions from dispatch or uncertainty; no automatic mutation retry | Actual provider/application verification; Codex native receipts require the shared endpoint |
| 9. Research sources and steps | Current-page/work-note evidence plus Google search and up to three read sources through background tabs in the real Chrome profile; live encrypted progress and actual-source appendix | Reload the updated extension and verify real Chrome/research service behavior |

All new code is original. External projects informed requirements; no source was
copied. Nothing has been pushed. Automated checks are evidence for the described
implementation, not proof of a complete Android/native-desktop workflow.

## External prerequisites that remain

Validation for this implementation: 675 tests passed, 1 skipped across 69 test
files. Core/runner, test, app, extension and IDE TypeScript checks pass; the
extension builds. Feature-manifest and diff checks pass. Biome passes against
the 261 project source/config files (existing warnings remain); local ignored
external projects and linked skill libraries are excluded from that check.
New recorded-operation extraction was also checked against the selected
real Codex rollout (20 retained operations, recorded completion), without
printing private command text or starting an agent.

- The supported Codex `app-server proxy` probe was repeated: the current shared
  socket still refuses connections. No new daemon/backend was started. Native
  question answering, turn interruption and pending-request recovery remain
  disabled. A queue message or accessibility click is not a substitute for a
  native approval response.
- Agent Desktop 1.2.0 is now installed locally from the official Windows release.
  Its archive checksum was verified, its envelope is 2.6 and Windows reports
  accessibility granted. The owner-only `desktop-provider.json` manifest records
  the executable hash; startup refuses a changed binary. The configured provider
  was checked and correctly refuses observation outside handover. A bounded,
  visible Windows Forms fixture then passed actual named-field typing, named-button
  activation and application postcondition read-back, with an exact PID/window
  binding. Existing apps were not targeted and the fixture was cleaned up. Real
  coding-app/phone handover tests remain. Runtime startup does not
  install tools automatically, and no antivirus settings were changed.
- Android adb and the checked SDK locations are unavailable. A physical-phone
  acceptance test cannot be replaced by local WebSocket tests.

## Mobile voice as the desktop partner

Voice requests now reach the same existing-conversation service as the Sessions
screen. The assistant can list desktop chats, read/select an exact chat, propose
a confirmed native message, and review that chat's workspace. Codex uses its
public saved title index so renamed desktop chats can be found by their displayed
titles. Unsupported native sending never falls back to starting a CLI task.

The assistant can take up to six planning/observation rounds and twelve tool calls
per spoken request. It stops at the first human confirmation, refuses identical
tool retries, bounds tool evidence, and reports step-limit or failure stops.
One spoken request can therefore discover an app, identify its window, observe
its controls and propose the next action. During explicit handover this works
through the installed accessibility provider; outside handover those operations
remain blocked. Desktop ownership and fresh-reference checks remain in code.

The phone sends its selected chat as structured context. Switching chats clears
the old selection/read-back, and a newer request supersedes old planning.
The voice Stop action now sends negotiated server cancellation, clears pending
confirmation and cancels owned handover commands/accessibility calls. It does not
claim to stop work already queued in a native coding app.

The shared phone/server confirmation parser now requires a complete confirmation
or choice phrase. A new sentence such as "Actually start the second task" cannot
approve the first pending task merely because it contains "start". Negative
words still refuse, and stale confirmation IDs cannot erase a newer read-back.
The phone's local/offline fallback also requires explicit CLI/runner intent (or
the explicitly selected New task form); it cannot silently substitute a runner
action for the selected desktop chat when the brain is unavailable.

The previously tested Codex executable is now configured locally in a hash-checked
`codex-desktop.json` manifest. Startup validated its queue help without sending a
message. `MALVES_CODEX_DESKTOP_BIN` remains an explicit override. The semantic
provider uses the analogous `desktop-provider.json` manifest and refuses checksum
changes; no `.env` secrets were edited or printed.

The real desktop fixture can be rerun after building the runner with:
`node scripts/verify-desktop-provider.mjs --fixture`. It is Windows-only, respects
the human-control lock, targets only the process it creates and closes that process
after testing. It does not run or control an existing coding agent.

Explicitly typed runner clarifications can also be dictated: their exact question
id and declared text choice are checked, the answer is read back, and first answer
wins. This does not turn a stored native question into an actionable request.

Examples for Android acceptance:

- "Read my Codex chat Review and push Malveon changes."
- "Ask that chat to explain its changes." Confirm the complete read-back.
- "Review that chat's workspace changes."
- "Take over the desktop." Confirm handover, then ask for a particular app/window.
- "Find the question in Cursor and tell me what it asks." Answering on screen
  still requires fresh targets and the existing read-back confirmations.
- Use voice Stop during planning; verify no later step or old confirmation acts.

## Real-device acceptance checklist

1. Build/open the updated Android app, configure the Codex executable, keep an
   existing chat open, and send a harmless diagnostic. Verify the same chat's
   reply appears automatically without a CLI task.
2. Background/foreground the phone, disconnect/reconnect, and reopen the chat.
   Verify transcript catch-up and persisted delivery receipts. Never infer a
   reply from queue acceptance.
3. Expand command output and per-file tracked patches. Verify sensitive file
   exclusion, workspace scope and offline/non-Git errors.
4. Exercise a runner clarification with an explicit text choice; answer from
   competing clients and check first-answer-wins, expiry and replay.
5. Take control, verify runner tasks stop and background/new input is blocked.
   Return control and verify old confirmations/references cannot act.
6. In explicit handover, change the screen/window after observation and verify
   refusal. Verify an accepted input is reported as dispatched, not as a
   semantically verified result.
7. Ask the assistant to research the current Chrome page. Check source URLs,
   work-note provenance and truthful failures when no sources are available.
