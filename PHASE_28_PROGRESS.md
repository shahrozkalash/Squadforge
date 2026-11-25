# Phase 28: Effects, Transitions and Animation Engine — Progress

Extends the Phase 20 effects/transitions and the Phase 26/27 rendering paths in place (`server/videoEditor/effects.ts` + wiring in the exporter, preview renderer, timeline and operations). Nothing was replaced; the Phase 20 single-effect preset still renders first, unchanged.

## Implemented

1. **Modular effects system** — one registry (`EFFECT_DEFS`) defines each effect's range, neutral value and ffmpeg filter: brightness (`eq`), contrast (`eq`), saturation (`eq`), temperature (`colortemperature`, −1 cool..+1 warm mapped to 9500K..3500K — ffmpeg names the illuminant, so lower Kelvin warms), blur (`boxblur`), sharpen (`unsharp`). Adding an effect is adding a registry entry. Clips carry an ordered `effects` stack; rendering order is legacy preset → stack order. Neutral values are omitted from the graph.
2. **Effect ordering, adjustment, removal** — operations `addEffect / updateEffect / removeEffect / moveEffect` (validated before mutation) via the same `/operations` route. Non-destructive: settings live in the project file; source media are never touched.
3. **More transitions** — the transition type widened from the Phase 20 literal to `crossfade, fade-black, fade-white, wipe-left, wipe-right, slide-left, slide-right, zoom-in`, mapped to ffmpeg xfade names and rendered by the same group/join machinery. Unknown types are rejected by `addTransition`, project validation, and deserialization. (Verified semantics: `wipe-left` reveals the incoming clip from the right edge — that is ffmpeg's definition, and the test asserts the real behaviour.)
4. **Keyframe animation** — `Keyframe` tracks on clips animate x, y, scale, rotation and opacity with linear or smooth (smoothstep) easing. `sampleKeyframes()` is the single interpolation implementation. The exporter compiles the same segments into ffmpeg time expressions: position in the overlay filter (output time), rotation via per-frame `rotate` angle, opacity via a `geq` alpha expression (geq names its timestamp `T`, not `t` — found and fixed during testing). Animated text: text elements keyframe x/y, compiled into drawtext expressions in export and sampled in preview.
5. **Preview/export consistency** — the Phase 27 preview renderer samples the same keyframes and the same `effectChainFor()` chains; a test renders the same animated instant through both paths and requires the pixels to match (they matched to ±14/255, and the export blend matched the analytic value (184,0,71) to within a few units).
6. **Generated app** — ClipForge's document model gained the ordered effect stack with the same registry semantics in its export graph, plus effect controls in the editor form; compile-verified genuinely (below). Transitions/keyframes are not yet mirrored in the generated app (documented limitation).

## Findings during verification (all fixed)

- ffmpeg's `scale` filter negotiates its output size once — `eval=frame` does **not** resize mid-stream (proven by frame-size probing). Scale keyframes therefore render as per-segment steps: the clip is split at keyframe times, each interval subdivided into ≤ ~0.75s steps, each segment scaled statically to the midpoint sample. Position/rotation/opacity remain exact expressions. The exporter states this in its result notes whenever scale is keyframed.
- `buildTimeExpression` initially shifted segment lengths by the time offset; caught by the opacity blend test and fixed (segment length is offset-invariant).
- During rotation animation the overlay rotates about its centre inside a fixed union bounding canvas (centre-anchored); static rotation keeps the exact per-angle bounding box from Phase 26.

## Verification

- `tests/phase28_effects_transitions_animation.test.ts`: **11/11 pass** — brightness/saturation/temperature pixel proofs vs control exports, blur edge softening, ordering proven with a non-linear pair (brightness clipping vs blur; pure convolutions commute and cannot prove order), removal restoring the original pixels, chain-order unit assertions, wipe-left and fade-black midpoint pixel proofs, unknown-transition rejection, sampler math (linear/smooth/holds/per-property), keyframed move+fade export with analytic blend values, preview≡export pixel match, animated scale footprint growth, animated text export, keyframe validation (range, duplicates, text opacity keyframes rejected rather than faked).
- Regression in the same run: Phase 20 (15/15), Phase 26 (12/12), Phase 27 (13/13) — **51/51 combined**.
- Generated ClipForge app compiled genuinely: `ClipForge.dll` 37,888 bytes sha256 `504c66287e6ac12c51f931e45f4fa247cfc1f76889d77d54f7e200cb682fafde`; exe sha256 `a61d10662f4e4895a394b6bd64e1c5fec4354a27c36163cb0b4d43d505917f12`.
- Lint ✅, production build ✅, typecheck ✅.

## Limitations (honest)

- Scale keyframes are step-approximated in export (≤ ~0.75s steps, midpoint-sampled) for the ffmpeg reason above; the preview shows the exact sampled glide, so preview and export can differ slightly mid-step for scale only. All other properties are exact in both.
- Text opacity cannot be keyframed (drawtext has no per-frame alpha); such keyframes are rejected at validation instead of being silently preview-only.
- No effect is provided that ffmpeg cannot really render: there are no glow/vignette/chroma-key controls, because no honest filter chain for them was verified in this phase.
- The generated desktop app mirrors effects but not transitions/keyframes yet.
