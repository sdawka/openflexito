# Integration notes: quality features (chroma denoise, reference flat, bounded levels)

What landed in `algo/` and `services/video/{stackModes,toneModes}.ts`, and exactly what the
catalogue (`videoModes.ts`) and the panel need to expose. Nothing here touches the catalogue,
the panel or the recorder; the params below are all optional on the mode-param interfaces, so
existing catalogue entries keep working unchanged until they are added.

## 1. `denoise` mode: chroma-heavy stage (`DenoiseParams.chroma`)

Code: `algo/chromaDenoise.ts` (`ChromaDenoiser`), wired in `stackModes.ts#denoiseMode` after the
burst merge. Reset on stream reconnect via `reset()` and automatically when the stage shift
exceeds 0.5 px (the merge warps its history, the chroma EMA does not).

| param    | type     | default | catalogue/UI |
|----------|----------|---------|--------------|
| `chroma` | `number` | `0` (off); suggested catalogue default **`1`** | Slider "Chroma denoise" 0–2 step 0.25. Tooltip: "Extra smoothing of colour speckle only, at half resolution, guided by the luma so edges stay sharp. 0 = off, 1 = normal, 2 = strong." |

Mapping inside the mode (no further params needed): guided-filter ε = 64·chroma² (0..255² units),
chroma EMA weight = min(0.95, 0.8·chroma), radius 4 on the half-res grid.
`stats()` gains `chroma`; `status()` appends `· chroma ×N` when on.
Cost estimate: ~¼ of a full-res guided filter plus one YCbCr split/merge pass, ≈ 8–12 ms at 1640×1232.

## 2. `enhance` mode: reference flat-field / dark (`flattenMode`, `flatStrength`)

Code: `algo/videoFlat.ts` (`VideoFlat`), `toneModes.ts` exports `setVideoFlat(flat | null)` and
`getVideoFlat()`. The run reads the module-level reference at every frame, so a capture made
during a recording takes effect at once; with `flattenMode: 'reference'` and no finalized
reference the flatten step is skipped (status says `flat: no reference captured`).

| param         | type                        | default     | catalogue/UI |
|---------------|-----------------------------|-------------|--------------|
| `flattenMode` | `'rolling' \| 'reference'`  | `'rolling'` | Select "Flatten" (shown when `flatten` is on): "Rolling estimate" / "Captured reference". Tooltip: "Rolling: estimate the background from the video itself. Reference: divide by a blank field you capture with the sample removed (exact, also removes dust and hot pixels)." |
| `flatStrength`| `number` 0..1               | `1`         | Slider "Flat strength" 0–1 step 0.05 (reference only). Tooltip: "Blend the correction toward none." |

UI the integrator must add (buttons next to the Flatten select, only for `'reference'`):

1. **Capture blank field** — with the sample moved away and the camera AE/AWB locked
   (`lockCamera({ ae: true, awb: true })`, keep it locked while recording, else the gain map is
   stale), feed 32 consecutive decoded frames to `flat.addReference(rgba, w, h)`.
2. **Capture dark (optional)** — LED off (`light.set`), 32 frames to `flat.addDark(rgba, w, h)`,
   LED back. Only worth it above ~4× analogue gain (dark-field / fluorescence); it also yields the
   hot-pixel list.
3. Then `flat.finalize()` (returns `false` without a reference) and `setVideoFlat(flat)`.
4. **Clear** — `setVideoFlat(null)`.
5. Persist with `flat.toJson()` / `VideoFlat.fromJson(json)` (plain numbers at a 1/8 grid, ≈ 100 kB
   at 1640×1232; store per LED level in IndexedDB, restore on load with `setVideoFlat`). The JSON
   carries `meanLuma` of the reference: when the live frame's mean luma differs by more than ~10 %
   show a "reference stale (lighting changed)" hint.

Frames for the capture come from the same decoded RGBA the recorder uses (`api/mjpegStream.ts`);
all frames of one capture must share one size (`addReference` throws otherwise).
`stats()` gains `flattenMode`, `flatStrength`, `flatReference` (bool).
Cost estimate: one lerp + two LUT lookups per channel per pixel, ≈ 6–10 ms at 1640×1232.

## 3. `enhance` mode: bounded stretch and levels strength

Code: `algo/videoTone.ts#StableLevels` gained `maxStretch` (class default 1 = unbounded, so other
callers are unchanged) and `strength` (default 1), plus `window()` returning the bounded
black/white points actually used. `enhanceVideoMode` sets `maxStretch` from `levelsMaxStretch`
(default **0.25**) and `strength` from `levelsStrength`.

Choice documented in the code: the gain 255/(white − black) is capped at 1/(1 − maxStretch), i.e.
at most `maxStretch` of the 0..255 range is remapped away (0.25 → gain ≤ 1.33, window ≥ 191
codes). A narrower measured window is widened symmetrically about its centre so mid-grey stays
put, then slid back inside 0..255. `colour.md` "bounded stretch": an empty field must not be
stretched into noise.

| param              | type          | default | catalogue/UI |
|--------------------|---------------|---------|--------------|
| `levelsMaxStretch` | `number` 0..1 | `0.25`  | Slider "Max stretch" 0–1 step 0.05 (shown when `levels` is on). Tooltip: "How much of the tonal range auto-levels may remap. 0.25 keeps an empty field from being stretched into noise; 1 = unbounded." |
| `levelsStrength`   | `number` 0..1 | `1`     | Slider "Levels strength" 0–1 step 0.05. Tooltip: "Blend auto-levels toward the original." |

`stats()` gains `maxStretch`, `levelsStrength`; `status()` now reports the bounded window.

Note for the catalogue: 0.25 is deliberately conservative (a 100..120 specimen stretches to only
~27 codes). If the mode is meant to look like the old unbounded behaviour by default, set the
catalogue default to 1 and let the user dial it down; the algo supports both.

## Tests

`src/lib/algo/__tests__/{chromaDenoise,videoFlat}.test.ts` (new), `videoTone.test.ts` (two new
cases). `npx vitest --run` on these plus `videoStack`/`burstMerge` is green; type-check is clean
for these files (the one `svelte-check` error at the time of writing is in another agent's
`algo/frameAttrib.ts`).
