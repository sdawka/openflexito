# Live page redesign: tool rail, drawer, HUD, immersive view

Goal: a bigger picture. Today `routes/Live.svelte` is `grid: 1fr 360px`, the right column a flat stack of
13 always-open panels (Sample, Stage, Focus, Look, Photo, Measure, Time-lapse, Camera, Illumination,
Tracking, Intelligence, Macro, Help). The 4:3 stream is width-limited on every laptop, so the sidebar
costs ~25 % of the image, and the basic controls (jog, Z, autofocus) are buried in it.

## Target layout (desktop, > 720 px)

```
┌──────────────────────────────────────────────────────────────┬──────────┬───┐
│ nav (compact, one row)                                        │          │   │
├──────────────────────────────────────────────────────────────┤  drawer  │ r │
│                                                              │ (one     │ a │
│                  stream (fills everything left)              │  panel,  │ i │
│   [HUD: pos/fps bottom-left]     [HUD: pad + Z + AF bottom-right]│  340px)  │ l │
│                                                              │          │   │
└──────────────────────────────────────────────────────────────┴──────────┴───┘
```

- **Tool rail** (`components/ToolRail.svelte`, 48 px wide, right edge): one button per tool, icon +
  tiny label, vertical, scrollable if short. Active tool highlighted. Clicking the active tool closes
  the drawer. `Esc` closes the drawer when focus is not in an input.
- **Drawer** (340 px, between stream and rail): shows exactly one panel. **All panels stay mounted**
  (their local `$state` such as PhotoPanel's mode/slices must survive switching) and inactive ones are
  hidden with `display: none` via a wrapper `div.tool[hidden]`. Opening state (`open: boolean`,
  `tool: ToolId`) lives in `store/ui.svelte.ts`, persisted to localStorage. Default on first visit:
  drawer **closed** so the image is as large as possible; the HUD gives jog + autofocus without it.
- **Tools** (`ToolId`, in this order): `stage` (StagePad), `focus` (the Focus panel now inline in
  Live.svelte: autofocus + live view processing; move it into `components/FocusPanel.svelte`),
  `camera` (CameraControls + LightControl in one drawer page, two `.panel`s stacked), `look`
  (LookPanel), `photo` (PhotoPanel), `measure` (MeasurePanel), `timelapse` (TimelapsePanel),
  `tracking` (TrackingPanel), `ai` (the Intelligence panel inline in Live.svelte → `components/IntelligencePanel.svelte`,
  it needs the detection/follow/search state; move that state and its handlers with it, the route keeps only
  what StreamView needs via the service/props), `sample` (SamplePanel), `macro` (MacroPanel),
  `help` (the "Mouse, keys and gamepad" details).
  Every panel keeps its existing `<div class="panel"><h3>Name</h3>` markup: the e2e suite selects
  `.panel:has(h3:has-text("Photo"))` and so on.
- **Busy badges on the rail**: a small dot on a tool's rail button when it has something running
  (photo `busy`, time-lapse running, tracking active, live stack active, recording, macro recording).
  Read cheap flags from the services only.
- **HUD** (`components/LiveHud.svelte`, absolutely positioned inside `.stream`, `pointer-events: none`
  on the container, `auto` on the buttons):
  - bottom-right: a compact translucent D-pad (◀ ▲ ▼ ▶, ■ stop centre), Z+ / Z− beside it, and an
    **AF** button (autofocus with the current mode/range from the Focus panel state; shows a spinner
    while running and cancels on second click). Buttons are 36 px (44 px on `pointer: coarse`).
    Press-and-hold jogs continuously through `JogController` (`lib/input/jog.ts`), the same object
    the keyboard uses; a tap moves one step (`settings.stepXY` / `settings.stepZ`). Use raw moves
    (`compensate: false`) exactly as StagePad does.
  - bottom-left: mono position `x y z` + fps + a "moving" indicator (the top status bar keeps its
    own; on desktop the HUD one is the primary read-out).
  - top-right: **Immersive** toggle (icon ⛶) and a "step" chip cycling XY step sizes (50/200/500/2000/5000).
  - HUD fades to 35 % opacity after 2.5 s without pointer movement over `.stream`, full on hover.
    Never intercepts drags: buttons only, no full-width bars.
- **Immersive mode** (`ui.immersive`): hides `nav`, the rail and the drawer; the stream fills the
  viewport; a small ⛶ exit button stays in the HUD and `Esc` / `F` toggle it (only when focus is not
  in an input and no Viewer overlay is open). Also request `document.documentElement.requestFullscreen()`
  when available, and drop immersive when the fullscreen change event fires with no element.
  App.svelte reads `ui.immersive` to hide the nav (keep the standby logic untouched).
- **Compact nav**: on desktop reduce `nav` to ~36 px (padding 3 px 10 px, tab padding 4 px 10 px).
  Hide the wordmark below 1000 px (show the `OF` mark). Leave the mobile rules alone.
- **Hints** (`.hint` toasts in Live.svelte): move them to the top-left so they never sit on the HUD.

## Mobile (≤ 720 px)

- Stream stays at the top (`aspect-ratio 4/3; max-height 60vh` as now). The rail becomes a
  horizontal, scrollable strip of icon buttons directly under the stream; the drawer opens beneath
  the strip and scrolls (padding-bottom `var(--tabbar-h)`). Drawer default **open on `stage`** on
  mobile (no hover HUD there) — read `matchMedia('(max-width: 720px)')` once at init when nothing is
  persisted.
- HUD on touch: only the AF button and the immersive toggle (the D-pad would fight the gesture area).
  Immersive on mobile hides the tab bar too (`.tabs`).

## Non-goals

- No change to StreamView's gesture model, frameChain, or any service. No new dependencies.
- No image cropping / `object-fit: cover`: overlays are computed from the contained geometry.

## e2e

`e2e/app.mjs` selects panels by `.panel:has(h3:has-text("X"))`. Because inactive drawer panels are
`display: none`, add near the top of the suite:

```js
const TOOL_OF = { Stage: 'stage', Focus: 'focus', Camera: 'camera', Illumination: 'camera', Look: 'look',
  Photo: 'photo', Measure: 'measure', 'Time-lapse': 'timelapse', Tracking: 'tracking', Intelligence: 'ai',
  Sample: 'sample', Macro: 'macro' }
async function tool(name) {   // open the Live drawer on a tool and return its panel locator
  const btn = page.locator(`.tool-rail button[data-tool="${TOOL_OF[name]}"]`)
  if (await btn.getAttribute('aria-pressed') !== 'true') await btn.click()
  return page.locator(`.panel:has(h3:has-text("${name}"))`)
}
```

and call `await tool('Photo')` before each step that touches a Live panel (calling it on an already
open tool is a no-op). Rail buttons carry `data-tool` and `aria-pressed`. Jog buttons keep their
titles (`W / ↑` etc.) so the jog step finds them either in the HUD or StagePad; make the e2e click
the StagePad ones inside `tool('Stage')`.

Run the suite alone against the fake: `cd device && .venv/bin/python -m openflexito --fake
--webapp-dir ../webapp/dist --port 8099` then `cd webapp && npm run test:e2e`.

## Files and ownership

| Agent | Owns |
|---|---|
| A layout | `routes/Live.svelte`, `components/ToolRail.svelte`, `components/FocusPanel.svelte`, `components/IntelligencePanel.svelte`, `store/ui.svelte.ts`, `App.svelte` (nav compaction + immersive), `app.css` additions, `e2e/app.mjs` `tool()` helper |
| B HUD | `components/LiveHud.svelte` (+ one `<LiveHud … />` line inside `.stream` in Live.svelte) |
| C verify | runs check / vitest / build / e2e, fixes what breaks, updates `CLAUDE.md` conventions |
