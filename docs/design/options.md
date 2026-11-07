# Game options: one module each (O4)

Roadmap node O4 (tooling, prio 0), 2026-11-07. Will was away and had delegated the calls; this file
is the record of them.

## The problem

Adding a game option meant editing the same one-line literals as every other thread:
`PaceFeel`, `DEFAULT_FEEL`, `paceFeel`, `checkPaceFeel` and `writePaceFeel` in `pacing.ts`;
`Settings`, `DEFAULT_SETTINGS`, `parseSettings`, an `XFeel`/`X_KEYS` pair in `settings.ts`; three
places in `main.ts`; a row in `door.ts` and a case in `door-page.ts`; five places in the viewer
(`scene-file.ts` type, writer, key list and reader, and `params.ts` `KEYSTONE_KEYS`) and three in its Scene panel (`controls.ts`
markup, reader and refresh); and the expected settings line in `door-e2e.test.ts` and `door.test.ts`.
That is up to 18 edits, and every one of them is a line another open PR is also editing. PT5
re-merged three times on these lines alone.

## What changed

Each option is declared once, in `packages/game/src/options/<name>.ts`:

```ts
export const marks = {
  feel: flag({ field: 'marks', url: 'keystone.marks', default: true,
               scene: { key: 'marks', json: 'boolean' }, panel: { label: '…' } }),
  setting: settingOption<'marks', boolean>({ field: 'marks', default: true, stored: storedBoolean,
               drives: { fields: ['marks'], feel: (v) => ({ marks: v }) },
               door: onOffRow('marks', 'Stone marks', { text: 'Carved', title: '…' }, { text: 'Off', title: '…' }) }),
} satisfies GameOption;
```

An option has a **feel part**, a **setting part**, or both:

- **The feel part** is a `PaceFeel` field. It has a `keystone.*` URL key with `parse` and `write`,
  and an optional `check`. It can also have a `scene` key, which carries it in the viewer's scene
  file, and a `panel` control in the viewer's Scene panel.
- **The setting part** is a `Settings` field stored in the browser. It has a `stored` validator, an
  optional URL say (`url`), a door row, and `drives`, the feel fields it sets unless the URL says
  them. `urlKeys` lists the URL keys that are dropped from the page's URL when the player changes it.

`options/index.ts` is the one list, in order. `options/registry.ts` derives `PaceFeel`, `Settings`,
`FEEL_OPTIONS` and `SETTING_OPTIONS` from it. Everything else is generic over those lists:

| Was | Now |
|---|---|
| `PaceFeel` interface, `DEFAULT_FEEL` literal | mapped type, defaults from the list |
| `paceFeel`, `checkPaceFeel`, `writePaceFeel` (one line per key) | loops over `FEEL_OPTIONS` |
| `Settings`, `DEFAULT_SETTINGS`, `parseSettings`, `urlSettings` | mapped type and loops over `SETTING_OPTIONS` |
| `cameraFeel` … `marksFeel`, `CAMERA_KEYS` … `MARKS_KEYS` | `settingFeel`, `settingUrlKeys` (the old names stay as one-line aliases) |
| `main.ts`: six `Object.assign(feel, xFeel(…))`, an `if` chain, a key ternary | `feelFromSettings`, one `settingFeel`, `settingUrlKeys` |
| door rows, door-page `switch` cases | `settingRows`, `doorChange` |
| scene file type, writer, key list, reader | loops over the feel options with a `scene` key |
| Scene panel markup, reader, refresh | `panelField`, `panelFeel`, `showPanelFeel` over options with a `panel` |
| viewer `KEYSTONE_KEYS` (keys refused outside rules=keystone) | the URL keys of the feel options with a `scene` key, then the line, rack and level rules |
| `door-e2e` and `door.test` settings literals | `{ ...DEFAULT_SETTINGS, ...changed }`, with `changed` gathered by `doorChange` as the test clicks |

The module-per-option layout covers the **game's own options only**: keystone feel and the player's
settings. Level rules (`keystone.scoring`, `settle`, `freeze`, `physics`), the render looks and the
viewer's sandbox keys are separate tables with their own owners. They stay where they are.

## Adding an option

1. Write `packages/game/src/options/<name>.ts`. Copy the nearest one: a flag (`spent.ts`), a choice
   (`balls.ts`), a number (`budget.ts`), feel plus setting (`marks.ts`), or a setting only
   (`sharp.ts`). Put the option's documentation on its export, because that is where readers look now.
2. Add two lines to `options/index.ts`: the import, in alphabetical order, and the entry, at the
   place in `OPTIONS` where it should appear in the URL, the scene file and the door. Keep each on a
   line of its own.
3. Read it where it is used, as `feel.<field>` or `settings.current.<field>`. If changing the setting
   must do more than set feel fields (re-carve stones, re-lay the HUD), add one `if (changed === …)`
   line in `main.ts`'s `applied`.
4. Test the option in its own test file. `options.test.ts` checks the registry rules (each module
   is listed, names are unique, parts are consistent) without being edited.

Option modules import only leaf modules: `aim`, `scene`, `frame-rate`, `quality`, `layout` and
`@tb/*`. They must never import `pacing`, `settings`, `params` or `door`, because those import the
list, and an option module would then read a binding before it exists. This is why `GAME_LOOK`,
`QUALITY_TITLES`, `LOOK_CHOICES` and `QUALITY_CHOICES`, `DEFAULT_BUDGET_MS`, the undo limits, and
`launchMode`, `ballStyle` and `effectStyle` moved into their option's module. The old modules
re-export them, so no import elsewhere changed.

## Alternatives considered

The brief named three. A fourth and a fifth came up while weighing them.

1. **`import.meta.glob('./options/*.ts')`, with no central list.** Rejected for two reasons.
   - It is Vite and vitest only. Under tsx, `import.meta.glob` is undefined (checked:
     `tsx -e 'import.meta.glob'` prints no glob). `packages/game` is loaded by tsx scripts such as
     `pnpm duel:bot` and `pnpm playtest:build`, so those would silently see no options.
   - A glob's result is typed `Record<string, unknown>`, so `PaceFeel` and `Settings` could no
     longer be derived. They would have to be written by hand again, which brings back a central
     literal.
2. **One ordered registry file, one import and one entry per line, `merge=union` in `.gitattributes`.**
   Chosen. Git still sees two adjacent inserts as a conflict, but the union driver keeps both
   sides' lines, which is the right answer for a list. This was checked: two branches that each
   added an import and an entry after the same neighbour merged with no conflict and both entries
   kept. Union merges have two failure modes, and both fail loudly:
   - two branches that edit the same line keep both versions;
   - an option removed on one side and moved on the other comes back.
   Both produce a duplicate import or entry. TypeScript refuses a duplicate import, and
   `options.test.ts` refuses a duplicate entry and a module missing from the list.
3. **Keep the literals, one key per line.** This is the cheapest, but it only partly solves the
   problem. Neighbours still conflict in each of the 18 places, and an option is still spread across
   eight files.
4. **Self-registering modules** (`import './marks.ts'` lines, each module calling `register(...)`).
   This gives one line per option, but it has the same type problem as the glob, plus
   import-order and hot-reload double-registration pitfalls. Rejected.
5. **Interface merging** (each module adds its field with `declare module` augmentation). This gives
   the types without a list, but the runtime still needs a list, so it does not remove one. Rejected
   as more magic for no gain.

Option 2 is the cheapest one that ends the conflicts for the game, the viewer, tsx scripts and the
bench runner alike.

One limit applies: GitHub's web merge and "Update branch" button do not run merge drivers. On
GitHub, a PR can therefore show a conflict in `options/index.ts` that a local
`git merge origin/main` resolves on its own. Threads merge locally already.

The first real test of this came while the PR was in flight. #250 merged `keystone.coats` and
`keystone.sun` as literals, and the rebase onto it turned them into `options/coats.ts` and
`options/sun.ts` with two lines each in the index. The golden tests stayed green.

## What stays the same, and the small differences

`packages/game/test/options-golden.test.ts` and `packages/viewer/test/feel-golden.test.ts` were
recorded from main at 1d7158e, before the registry (PR #259), and pass unchanged after it. They
pin:
- every feel default and its order;
- each `keystone.*` key's reading, refusal wording, written form and read-back (101 cases);
- the URL with every feel flipped (which pins the order);
- `checkPaceFeel`;
- `parseSettings` on 35 stored values, and `urlSettings`;
- the six setting-to-feel functions and their key lists;
- the door's Advanced rows (exact markup and order);
- in the viewer, the URL, the scene file's `rules`, the scene file read back, and its refusals.

These are the observable differences, all deliberate:

- **The stored settings' key order.** `tb.settings.v1` now lists its keys in the door's order, so
  `sharp` moves after `layout`. Reading is field by field, so nothing reads the order.
- **Several bad keys in one URL.** The first refused key is now the first in the list's order.
  Before, `budget` and `undo` were checked ahead of the flags. `checkPaceFeel` behaves the same way.
  A URL or panel with a single bad value reads exactly as before.
- **A door click with an unknown `data-arg` is ignored.** Before, the click was mapped to a fixed
  value (for example, camera fell back to still). No button carries an unknown argument.
- **The viewer's Scene panel lists its feel controls in the URL's order.** "Frames drawn" now
  comes before "rapid fire", and the freezes field closes the block instead of sitting after undo
  memory. Names, values and behaviour are the same.

The scene file still does not carry `turnview`, `arcs` or `handoff`, because they have no scene
key, exactly as before; the golden test records that gap. Giving them one would change saved
scenes, so it is left as a follow-up for a thread that wants it.
