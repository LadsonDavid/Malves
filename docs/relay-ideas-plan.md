# Plan: ideas adopted from Agent Relay

Source: an audit of `AgentWorkforce/relay` (Apache-2.0). Only **ideas** are taken, never
code, so nothing goes in `THIRD-PARTY.md`. If code is ever copied, add it there and to
the dissertation's declaration first.

## Rules for every work package

- **Test first** for logic (test-driven-development): a failing test, then the code.
- **Ports and adapters stay as they are** (clean-architecture): rules go in `core`,
  tools and files in `runner`. `core/test/boundary.test.ts` keeps guarding that.
- **Windows first.** No `.cmd` shims, `node:path` for paths, no mode-bit assumptions
  (Windows ignores `0o600`, so file safety there rests on the profile folder's ACL).
- **No new dependency** unless a package already in the lockfile cannot do the job.
- **One pull request per phase**, CI green on Linux and Windows.
- **Fitness functions** (evolutionary-architectures): each phase leaves a check that fails
  if the property it adds is lost (see "Guard" below).

## Work packages

| # | Idea | Where | Guard (what fails if it regresses) |
|---|---|---|---|
| 1 | Atomic, owner-only secret files | `runner/src/secure-file.ts`; used by `system.ts`, `caller.ts` | Test: no `writeFileSync` of a token/key file outside `secure-file.ts` |
| 2 | Log redaction, broad patterns | `runner/src/redact.ts`; `background.ts` pipes serve output through it; vault conversation log | Table test of 20 key formats |
| 3 | Safe typed text | `runner/src/adapters/assistant/safe-text.ts`; used by `nutDesktop().type` | Test: control characters never reach the keyboard |
| 4 | `malves doctor` | `runner/src/doctor.ts`; `malves doctor`; link command `doctor.run`; app Settings → Check setup | Each check is a pure function with a fake environment |
| 5 | Visible degraded mode | derived from doctor checks + runtime state; shown on Home | Test: each missing capability produces one plain-language line |
| 6 | Notification outbox (dead letters) | `runner/src/adapters/push/outbox.ts`; used by `NtfyPush.notify` | Fake clock: queued while offline, delivered once on connect, expires after 24 h |
| 7 | Question reminders | `core` `Questions` + optional `Notifier.questionReminder` | Test: at most 2 reminders, none after close, never changes the outcome |
| 8 | ~~Replay gap signal~~ | **Dropped**: the event log never prunes, so replay is exact | Existing log tests cover contiguity |
| 9 | Decision capture | `runner/src/adapters/assistant/journal.ts`; a vault note per finished task, weekly compaction without any model | Test: note content, weekly roll-up, no network |
| 10 | Bounded session handoff | `continuation()` keeps the original goal + latest turns, marks what was left out | Test: always under budget, first turn kept |
| 11 | Control audit trail | new events `control.started` / `control.ended`; `malves audit` | Test: screen takeover and handover both log who and when |
| 12 | One-tap pairing link | `malves://pair?d=…`; console `pair link`; app opens the pairing flow | Test: link round-trips the offer, expires with the code |
| 13 | Windows runner bundle + installer script | CI job builds a zip (`pnpm deploy`); `install.ps1` verifies SHA-256, runs doctor | Bundle smoke test: `node main.js doctor` from the extracted folder |
| 14 | Feature manifest | `features.json` + `scripts/check-features.mjs` in CI | The check fails on an unknown status or a missing procedure |
| 15 | Assistant evals | scripted-brain scenarios (injection, read-back, refusal); optional live mode | The scenarios are tests |
| 16 | CI hygiene | actions pinned by commit, gitleaks, dependency review, Dependabot | The workflow files are the check |

## What was built, and what differs from the table above

All but item 8 are built. Differences: item 15 is a table of nine state-changing tools called by a
fooled brain (no live-model eval mode: add one when a real brain is worth scoring); item 13 is a zip
with its own Node.js plus `install.ps1`, not an `.exe` installer; item 9 keeps the journal in plain
Markdown beside the memory notes rather than inside the memory index.

## Phases (each its own pull request)

1. **Safety base** — 1, 2, 3.
2. **Setup help** — 4, 5, 12.
3. **Reliability** — 6, 7.
4. **Memory and audit** — 9, 10, 11.
5. **Quality gates** — 14, 15, 16.
6. **Install** — 13.

## Known limits (said now, not discovered later)

- The Windows bundle can be built and smoke-tested here, but not on a clean machine
  without Node; that last step needs a real test by the owner.
- Phone screens (4, 5, 12) are written against the Expo SDK 57 docs and can only be
  seen once a new APK is built.
- Redaction is pattern based. It lowers risk; it is not a guarantee.
