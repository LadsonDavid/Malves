# Real-time Android and desktop testing

Use the APK built from `codex/repair-mobile-agent-flow`, not an older main release.
In GitHub Actions, open the APK workflow run for that branch, download its `malves`
artifact, extract `malves.apk`, and install it on Android. This is a development
acceptance test; native approval support is still unavailable as described below.

## Start the updated desktop runner

From PowerShell, with Node 22.12 or newer and dependencies already installed:

```powershell
Set-Location <path to your malves checkout>
node node_modules/typescript/bin/tsc -b
node node_modules/typescript/bin/tsc -p packages/extension/tsconfig.json
node --env-file-if-exists=.env scripts/verify-desktop-provider.mjs --fixture
node --env-file-if-exists=.env packages/runner/dist/main.js serve
```

Close an older foreground runner with Ctrl+C before starting this one. If an
autostart runner holds the lock, stop that instance through its existing launcher;
do not terminate unrelated Node processes. Keep Tailscale connected on both devices.
Existing phone pairing can be reused. For a new pairing, type `pair` into the
runner and scan the QR within two minutes. Verify the phone reports connected.

This computer already has locally verified Codex and Agent Desktop executable
manifests under `~/.malves`; these local files are not shipped in Git. On another
computer, configure the executable paths using `.env.example` and the investigation
notes. Voice also requires the configured assistant brain; keys remain local.

## Test the existing Codex desktop chat

1. Keep Codex desktop open on **Review and push Malveon changes**.
2. On Android open **Work > Sessions**, select that exact Codex chat, and choose
   desktop continuation. Send: `Reply only MOBILE_OK; do not run tools or change files`.
3. Confirm the exact read-back if prompted. Verify the message and `MOBILE_OK`
   appear in the same desktop chat and then on the phone. Queue acceptance alone
   is not a reply. No replacement CLI task should appear.
4. Background/foreground the phone, disconnect/reconnect, and reopen the chat.
   Check history and delivery receipts catch up without a duplicate send.
5. Open **View workspace changes** and expand a tracked file patch. Compare it
   with Git on the desktop. This view does not accept or reject native edits.

## Test voice and ownership

Use the installed APK microphone and say:

- "Read my Codex chat Review and push Malveon changes."
- "Ask that chat to reply only VOICE_OK without running tools or changing files."
  Approve only the correct complete read-back.
- "Review that chat's workspace changes."
- "Take over the desktop." Confirm handover before requesting on-screen actions.

Start with the isolated desktop fixture above before controlling an existing app.
Taking human control should stop runner tasks and block new runner actions.
Returning control must invalidate earlier observations and confirmations. Voice
Stop cancels Malves planning and its owned actions; it does not interrupt a turn
already queued inside Codex. A different instruction such as "Actually start a
different task" must never approve an older pending action.

For Chrome research, reload the unpacked extension after building it, connect it
using the runner's `extension` command, and ask about the current public page.
Check that returned sources and progress correspond to the pages actually read.

## Expected limitations

The current Codex native shared control socket is unavailable. Native live
questions/approvals, accepting or rejecting proposed native edits, unpersisted
token streaming, and native interruption/recovery remain disabled. Desktop chat
updates come from recorded transcripts. Claude, Cursor and Antigravity do not all
have equivalent verified native integrations. Explicit handover provides bounded,
confirmed on-screen control where supported; it is not unrestricted autonomous
control of every desktop operation. Real-phone acceptance remains to be completed.
