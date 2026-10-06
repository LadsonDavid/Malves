# DESIGN.md

The phone app follows the **Malveon blueprint** system (the owner's
`Malveon/DESIGN.md`): editorial blueprint, restrained and type-led, a cobalt
anchor on paper, white text on navy zones. This file records only how it maps
onto React Native. Tokens live in `packages/app/src/ui.tsx`; icons in
`packages/app/src/icons.tsx`.

## Mapping

| Blueprint | In the app |
|---|---|
| `ln-paper` `#fbfaf8`, `ln-paper-2`, `ln-ink`, `ln-ink-60`, `ln-line-light` | Light theme page, sunken/pressed, text, secondary text, hairlines |
| `ln-navy` `#0a0a0a`, `ln-navy-soft` `#1a1a1a`, `ln-on-navy`, `ln-mute`, `ln-line-dark` | Dark theme, and the navy zone Malves lives in (both themes) |
| `ln-cobalt` `#012bff` | The one primary button per screen, selection, the mic. Link text on navy uses `ln-azure` (cobalt text is too dark there) |
| Semantic `ln-pass` / `ln-danger` / `ln-caution` | Status dots and tints |
| Fraunces | Screen titles only (`Title`) |
| Geist 400 / 500 / 600 | Body, buttons, headings. One family per weight: Android won't pick weights of a custom font |
| Geist Mono | Eyebrows, ids, times, durations, meta lines, tabular numbers |
| Radius 12 / 18 / pill | Buttons, inputs, choices / panels, the Malves zone / dots |
| Heroicons outline | `src/icons.tsx` is the single import point. No emoji in the UI |

## Deliberate differences from the web system

- **Touch targets:** buttons are at least 48 dp tall (the web system's 32 px is
  for a mouse).
- **Status pills:** a dot in the status colour with the word in ink, on a 12%
  tint, instead of coloured text: 12 px orange or red text on paper doesn't
  reach 4.5:1.
- **Theme:** follows the phone's light/dark setting live; the Malves panel is
  a navy zone in both.
- **Motion:** none beyond press states, as the product register asks.

## Rules kept

Lists are rows separated by hairlines inside one panel, not stacks of cards.
Cards only for things that stand alone (a question, a form). No side-stripe
borders, gradients, glass or glows. Empty states are one short sentence. No em
dashes in visible text.
