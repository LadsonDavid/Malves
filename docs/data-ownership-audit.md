# Data ownership audit

This is a single-owner application. The boundaries reviewed here are desktop
app/chat, runner task, workspace, assistant conversation, question and device.
An owner-wide list is intentional; it does not establish an action target.

## Confirmed defects and local changes

- Shared repository before/after snapshots were presented as a task's changes.
  They can include concurrent editor work. Shared-checkout automatic attribution
  and commit prompts are now disabled. Only an explicitly proven exclusive
  task checkout may opt in; production does not currently provide that proof.
  Existing inferred commit prompts are declined on startup. The commit path
  also refuses file contents changed since review. Isolated checkout integration
  remains outstanding; this is a safety restriction, not completed task attribution.
- Assistant start_task now requires explicit CLI/runner intent even when desktop
  connectors are absent. A request to search Chrome cannot silently start Claude.
- Multiple ready agents no longer imply Claude. Missing agent choice needs
  clarification. Unknown/ambiguous projects do not select the last project.
- Invalid task IDs never select another task. Reply and rerun require an ID;
  omitted IDs in remaining lookups are accepted only for a single candidate.
- IDE actions never substitute a different IDE for an invalid ID. Opening task
  changes requires an exact task ID instead of scanning recent tasks.
- Phone local voice does not choose the first workspace or last agent. It does
  not select the newest finished task when multiple tasks exist.
- Changing or leaving the phone's selected desktop chat invalidates the server's
  selection and pending confirmation. A model cannot read/select a different
  desktop chat while the phone explicitly focuses another one.

## Boundaries inspected and preserved

- Desktop session reads/sends resolve by app plus session ID. Desktop continuation
  does not fall back to a CLI. Recorded history is separate from live native state.
- Workspace review resolves the folder from the selected desktop session, is
  explicitly not attributed to that chat, and excludes sensitive paths.
- Core questions use exact question IDs, exact choices, first-answer-wins and
  expiry. The questions inbox is owner-wide by design. Legacy commit prompts
  require the additional ownership invalidation described above.
- App link state resets on connection change. Command replay, delivery receipts
  and native queue duplicate prevention remain in their existing scoped stores.
- Work memory, leads, the activity overview and explicit stop-all are owner-wide
  by design. They should not be interpreted as the currently selected chat's data.

## Validation and limits

Real Git regression tests cover shared-checkout exclusion, invalidating old
commit prompts and refusing changed review contents. Assistant tests cover
browser-to-CLI refusal without desktop connectors, missing agent/project choices,
and invalid task IDs leaving another chat's task untouched. Existing tests cover
question routing, replay, desktop session targeting and control ownership.

This source/test audit does not establish native desktop edit authorship and is
not a claim that every phone/native-app race has been reproduced. Real Android
acceptance and exclusive task-checkout commit integration remain necessary.
