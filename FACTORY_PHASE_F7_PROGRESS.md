# Factory Phase F7 — Games Workflow: Progress

**Date:** 2026-11-27. **Status: implemented and verified locally; not
pushed.** Companion: `FACTORY_PHASE_F7_ACCEPTANCE_REPORT.md`.
F8 not started.

## Audit — what existed for games, and the gap

### Existing pieces (file-verified)

| Piece | Where | State |
| :-- | :-- | :--- |
| Game team as data | `server/swarm/categoryTeams.ts` (F5) | `game_application` → Game Development Team, profile `game_creative_application`, verification chain resolved through the registry |
| Generation profile | `server/swarm/generationProfiles.ts` | `game_creative_application` (2D canvas games, physics, game loop) |
| 2D engine + demo game | `server/gameEngine/` (Phase 24) | Deterministic fixed-timestep engine; a complete playable HTML5 platformer whose shipped `game.js` core is DOM-free and Node-simulatable by design (`module.exports` guard); procedural WAV audio; asset manager; profiler (0.0216 ms/step) |
| 3D engine | `server/scene3d/` (Phase 21) | Scene graph, software renderer, OBJ + glTF 2.0 exporters, generated C# 3D app |
| 3D game | `GameProjectGenerator.generateWinForms3dGame` (Phase 24) | CubeQuest on the Phase 21 stack; compile-verified via the Phase 18 pipeline in Phase 24 (PE-verified `.exe`); GUI never run |
| Multiplayer | `server/gameEngine/multiplayer.ts` (Phase 24) | Authoritative RFC 6455 WebSocket server: input-only protocol, server simulation, seq + rate checks, shared scoreboard; instanced sessions |
| Game routes | `server/gameEngine/gameRoutes.ts` | `/generate` (html5 \| winforms3d into a build's files), `/simulate`, `/profile`, multiplayer start/stop/status |
| Swarm build chain | `server/swarm/swarmOrchestrator.ts` (F2–F4) | Planner → tasks → parallel workers → sandbox gate → verifier → IntegrationAgent → HonestVerificationService |
| Environment contract | `server/environment/` (F6) | Web adapter: open/build/test/preview/export over the platform store |

### The gap between "pieces" and "one workflow"

1. **No wiring from a game description to a game build.** The swarm's
   seeded task graphs are category-blind connected-application graphs
   (`src/core/engine.ts`, …). The platform's real mechanism for a
   category-shaped file set is the planner's `create_task` actions —
   a game build's files come from the planner, and nothing connected
   the F5 game team, the swarm chain, and the game generator's output
   into one flow.
2. **No reusable playability gate.** Phase 24 simulated its demo
   inside its own suite, but no component took a *built project's
   files* and returned a playability verdict (loop ticks, input
   changes state, gameplay progresses, no runtime errors) that a
   workflow could gate a delivery on.
3. **No delivery verdict for games.** Nothing combined "swarm build
   completed + environment cycle green + game actually plays" into
   the single verified/not-verified answer a delivered game needs.

## What was built

### `server/gameEngine/playabilityChecker.ts` (new)

`checkGamePlayability(files)` — the headless runtime harness. It
executes the delivered `game.js` in a `node:vm` context whose only
globals are a `module`/`exports` pair and a silent console — no
`require`, no `process`, no host bindings — so the game's DOM-free
simulation core runs exactly as it does under Node and the browser
glue (guarded by `typeof document !== 'undefined'`) stays inert.
Seven deterministic checks: package completeness (canvas + script
wiring), parse, headless load with core export, physics settle
(player grounded at y=380 after 90 no-input steps), input response
(~240px over 60 held-right steps), gameplay progression (the Phase 24
test 6.1 scripted play — walk + timed jump — collects a coin), and
determinism (the same scripted play twice lands on identical state).
Any exception at load or during simulation is captured into
`runtimeErrors` and makes the verdict not playable. A step budget
(20,000) bounds pathological cores. In the proof run the checker
simulated **412 steps** across four world runs.

Why vm and not the sandbox ExecutionBackend: the checker executes
the platform's own generated game core — a pure, DOM-free,
side-effect-free simulation module that Phase 24 designed to be
simulated in-process (its `/simulate` route and test 6.1 do exactly
this) — inside an isolated context with no host capabilities. It is
a verification harness for that core's behaviour, in the repo's
established Phase 24 evidence style; it does not execute arbitrary
project code as a platform execution path, and the swarm's sandbox
gate (which ran the project's own test suite through the platform
test gate) remains the build-time execution control.

### `server/gameEngine/gameWorkflow.ts` (new)

`GameWorkflow` — the workflow's decision points as shared code:

- `plan(description)` — team resolution from F5 data only
  (`CategoryTeamRegistry.selectForRequest` + `resolve`); dangling
  team data throws the named `CategoryTeamResolutionError`.
- `runEnvironmentCycle({ projectId, userId, title })` — opens the
  swarm build's project through the F6 web adapter and runs build /
  runTests / preview / exportArtifact through contract operations
  only, reads the delivered files back through the contract, applies
  the playability gate, and computes the delivery verdict.
- `verifyDelivery({ tests, artifact, playability })` — the verdict
  rule, factored out for direct assertion: verified ⇔ test cycle
  passed with zero failures AND a non-empty artifact exists AND the
  playability report says playable.
- `assessPlayability(files)` — the gate, exposed for direct use.

Both modules are exported from `server/gameEngine/index.ts`.

### The suite — `tests/factory_phase_f7_games_workflow.test.ts` (4 tests)

1. **End-to-end 2D workflow.** Plan assertions (category
   `game_application`, Game Development Team,
   `game_creative_application`, all members resolve to models,
   verifier = claude via the registry). Then a real `startSwarm`
   build over the stub transport: the stub planner answers with the
   platform's real planner mechanism — four `create_task` actions
   carrying the game project's file paths (game.js; index.html +
   styles.css; package.json + tsconfig.json; tests/game.test.ts) —
   and the stub workers write the platform's own generator output for
   the game files, the workflow scaffolding for package/config, and a
   project test file that plays the shipped core (Phase 24 style).
   Assertions: build `completed` and classified `game_application`;
   verifier approved; every sandbox check passed cleanly; all planned
   tasks completed; the tree contains all six files with `game.js`
   and `index.html` byte-identical to the generator output. Then
   `runEnvironmentCycle`: contract build honestly `skipped` (a static
   HTML5 game has no bundle entry point — the adapter says so and the
   workflow surfaces it as-is); contract test cycle `passed`, 2/2
   project gameplay tests; preview produced with its mode labelled;
   export a ZIP whose SHA-256 matches the bytes on disk; playability
   all seven checks green, 412 steps, coin collected, score ≥ 100;
   delivery `verified === true`.
2. **Broken game fails.** Control: the genuine files are playable.
   Injection: `throw new Error('Injected runtime fault (F7)')` at the
   top of the core's `step` — the checker reports not playable with
   the error named in `runtimeErrors`, and `verifyDelivery` refuses
   the delivery even with green tests and a real artifact.
3. **3D variant.** `generateWinForms3dGame` file set asserted
   (CubeQuest on the Phase 21 stack); the game's arena built as a
   scene3d scene (ground plane, hero cube with position keyframes,
   five pickups); OBJ export parsed back (vertices/faces present,
   every face index within range, MTL carries materials); glTF export
   parsed back (asset 2.0, ≥6 meshes, accessors present, embedded
   buffer decodes to its declared byteLength, every bufferView inside
   the buffer, one animation).
4. **Multiplayer foundation in the workflow.** A real `GameServer`
   with two WebSocket clients: for a shared broadcast tick both
   clients' scoreboards are deep-equal; A moves server-side from
   inputs only; A's claimed teleport (`x: 99999`) is ignored (position
   unchanged); disconnect cleans up.

## Two test-authoring corrections during development

- The first run failed on `artifactBytes.length ===
  artifact.sizeBytes`: ProductionBuilder's `totalSize` (which the F6
  contract surfaces as `sizeBytes`) is the *uncompressed* total of
  the packaged bundle contents (11,386 B), not the ZIP archive length
  (5,167 B). The assertion was wrong, not the code; the byte-exact
  check is the SHA-256 equality, which passed. Documented here and in
  the test so the semantics are not misread again.
- The step-count floor was initially set at 1,000 from a guess; the
  deterministic script actually runs 412 steps (90 settle + 60 input
  + two scripted plays). The floor is now 400 with the arithmetic
  recorded in the test.

## Verification (counts from printed summaries)

- F7 suite: **4/4**.
- Phase 21 + Phase 24 + F5 in one run: **39/39**.
- F6 contract + F2 gauntlet in one run: **15/15**.
- Orchestration + Phase 4: **41/41** — both F2-fixed tests
  (`orchestration.test.ts:334`, phase4 test 19) green; no regression.
- `npm run lint` clean; `npm run build` succeeds.
- Full suite not re-run (30+ min on this VM); the batches above cover
  every touched surface (game engine, scene3d, teams, environment,
  orchestration chain).

## Limitations

- **Stub transport.** Planner/worker/verifier model calls run over
  the F2 stub seam; the workflow mechanics are proven, live
  generation is not (F1's documented negative stands — no provider
  keys in this environment). The game content is the platform's own
  Phase 24 generator output, labelled as such everywhere.
- **Contract build is `skipped` for the static game** — bundle
  validation has no entry point to bundle. The game's build-time
  gates are the swarm sandbox chain and the contract test cycle; the
  workflow reports the skip rather than dressing it as a build.
- **3D is generation + export, not a played 3D game.** The WinForms
  game's compile evidence is Phase 24's (genuine PE-verified build);
  F7 does not recompile it and its GUI has never run anywhere. The
  scene export proof is structural parsing (the Phase 21 evidence
  style): the repo has OBJ/glTF *exporters* but no standalone
  importer module, so "parses" here means the exports parse back
  under strict structural validation, not a repo importer round-trip.
- **Multiplayer is the foundation**: instanced per-player worlds with
  a shared scoreboard — not shared-world co-op (Phase 24 limitation
  stands); no TLS/auth on the socket.
- **Playability scope**: the checker gates the generated HTML5
  platformer shape (a `game.js` exporting the simulation core). Other
  game shapes would need their own core contract; the checker refuses
  (not playable) rather than guessing when the core export is absent.
- The environment cycle runs on the web adapter only; the desktop
  adapter's game story would be the WinForms build, which is F11
  territory (desktop workflow), not claimed here.
