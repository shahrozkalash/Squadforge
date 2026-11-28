# Factory Phase F7 — Games Workflow: Acceptance Report

**Date:** 2026-11-27. **Verdict: F7 criteria met**, with the claim
scoping below recorded plainly. Implemented and verified locally;
not pushed. F8 not started. Companion:
`FACTORY_PHASE_F7_PROGRESS.md` (audit map, wiring, design record).

## What was delivered

The games category works as **one workflow** on the factory
machinery, with the workflow's decision points in shared code
(`server/gameEngine/gameWorkflow.ts`, `server/gameEngine/playabilityChecker.ts`,
both exported from the game engine index):

```
description → GameWorkflow.plan            (F5 team by data)
            → SwarmOrchestrator build      (F2–F4 chain + F4 gates)
            → GameWorkflow.runEnvironmentCycle  (F6 contract, web)
            → checkGamePlayability         (headless execution gate)
            → verified delivery verdict    (tests + artifact + playable)
```

## Criterion-by-criterion verdict (roadmap acceptance criteria)

### 1. A described 2D game builds end-to-end; the shipped game code is simulated in tests (Phase 24 evidence style) and the package loads/runs headlessly with no runtime errors — **MET**

`tests/factory_phase_f7_games_workflow.test.ts` test 1 drives the
whole workflow for "Build a 2D platformer game where a player runs
and jumps across platforms, collects coins, stomps a patrolling
enemy and reaches the goal":

- **Team by data:** `GameWorkflow.plan` resolves
  `game_application` → **Game Development Team**, profile
  `game_creative_application`; every member resolves to a registered
  model; the verification chain's verifier resolves to claude through
  the registry.
- **Swarm build:** the real `SwarmOrchestrator.startSwarm` chain over
  the stub transport. The stub planner uses the platform's real
  planner mechanism (`create_task` actions carrying the game file
  paths); stub workers write the platform's own Phase 24 generator
  output. The build ends `completed`, classified `game_application`,
  with `verifier_approved` recorded, every sandbox integrity check
  "passed cleanly", all planned tasks completed, and the tree's
  `game.js`/`index.html` byte-identical to the generator output.
- **Environment cycle (F6 contract, web adapter):** build honestly
  **`skipped`** (a static HTML5 game has no bundle entry point — the
  adapter's own verdict, surfaced as-is); test cycle **passed** with
  the project's own gameplay tests 2/2 through the platform test
  gate; preview produced with its generator mode label; export a
  real ZIP (5,167 B on disk) whose recorded SHA-256 matches the bytes
  on disk. (The contract's `sizeBytes` is the builder's uncompressed
  bundle total, 11,386 B — semantics recorded in the progress doc.)
- **Playability (the shipped code, simulated):** the delivered
  `game.js` is executed in an isolated `node:vm` context (no host
  bindings) and played with deterministic scripted inputs — **412
  simulation steps, zero runtime errors**, all seven checks green:
  package completeness; parse; headless load; the player falls and
  lands grounded at y=380; holding "right" moves the player ~240px;
  scripted play (walk + timed jump, the Phase 24 6.1 script)
  collects a coin (score ≥ 100); two identical plays land on
  identical state. Delivery `verified === true`, where verified
  requires tests passed AND artifact exported AND playable.

### 2. A described 3D scene/game variant exports a real OBJ or glTF that parses with the repo's own importers — **MET, with the importer scope stated**

Test 3: the workflow generates the 3D game project
(`generateWinForms3dGame` — CubeQuest on the Phase 21 stack; full
file set asserted) and builds the game's arena as a scene3d scene
(ground plane, keyframed hero cube, five pickups). The OBJ export
parses back: vertices and faces present, **every face index within
the exported vertex range**, MTL carries the materials. The glTF
export parses back: asset version 2.0, ≥6 meshes, accessors present,
the embedded base64 buffer decodes to exactly its declared
`byteLength`, every bufferView lies inside the buffer, and the hero
keyframes export as one animation.

Scope, plainly: the repo ships OBJ/glTF **exporters** and validates
exports by structural parsing (the Phase 21 evidence style, tests
6.1/6.2) — there is no standalone importer module to round-trip
through, so the parse proof is strict structural validation of the
exported bytes, not an importer round-trip. The C# game's build
evidence remains Phase 24's genuine PE-verified compile; F7 does not
recompile it, and the generated GUI has never been run.

### 3. The multiplayer foundation is exercised: two simulated clients stay in sync and a cheat attempt is rejected (Phase 24 proofs re-run inside the workflow) — **MET**

Test 4 runs a real `GameServer` (Phase 24 authoritative WebSocket
server) with two clients inside the workflow suite:

- **Sync:** for a broadcast tick both clients received, their shared
  scoreboard views are **deep-equal** — one authoritative simulation,
  two observers; the scoreboard lists both players.
- **Server authority:** client A moves server-side from input intents
  only (x advances > 30px under held "right").
- **Cheat rejected:** A sends an input carrying a claimed teleport
  (`x: 99999, y: -500`); the server ignores position fields by
  construction — A's position does not teleport and does not move at
  all from the claim (< 40px drift bound, observed ~0).
- Disconnect cleanup asserted (client count drops to 1).

Scope: this is the Phase 24 foundation — instanced per-player worlds
with a shared scoreboard, **not** shared-world co-op; no TLS/auth on
the socket. Those limitations stand and are not dressed up.

### 4. Phase 21 + Phase 24 suites pass; lint and build pass — **MET**

- Phase 21 + Phase 24 + F5 suites in one run: **39/39**.
- F6 contract + F2 gauntlet: **15/15**. F7 suite: **4/4**.
- Orchestration + Phase 4: **41/41** (both F2-fixed tests green — no
  regression).
- `npm run lint` clean; `npm run build` succeeds.

## Claim table — 2D / 3D / multiplayer

| Claim | Verdict | Evidence |
| :-- | :-- | :-- |
| **2D game, described → playable packaged game through the factory workflow** | **Proven** (stub transport) | F7 test 1: team by data → swarm build through the F4 gates → contract cycle → headless play (412 steps, coin collected, 0 runtime errors) → verified delivery with a hash-matched ZIP |
| **2D playability gate** | **Proven** | `playabilityChecker.ts` (vm-isolated execution + 7 behavioural checks); F7 test 2: injected runtime error → not playable, delivery refused |
| **3D game project generation** | **Proven** (generation; compile evidence is Phase 24's) | F7 test 3 file-set assertions on `generateWinForms3dGame`; Phase 24's genuine PE-verified CubeQuest build stands as the compile record |
| **3D scene export (OBJ/glTF)** | **Proven** (structural parse) | F7 test 3: OBJ face indices in range; glTF buffer/accessor/animation consistency |
| **3D game played/runnable in the workflow** | **Not claimed** | The WinForms GUI has never run on any machine (Phase 24/57 standing record); no headless 3D play proof exists |
| **Multiplayer foundation in the workflow** | **Proven** (foundation scope) | F7 test 4: two clients, shared-tick scoreboard sync, input-only movement, teleport claim rejected |
| **Multiplayer shared-world co-op** | **Not implemented** | Phase 24 design is instanced sessions + shared scoreboard; stated, not hidden |
| **Live model generation of a game** | **Not claimed** | No live provider exists in this environment (F1 documented negative); planner/worker calls run over the stub transport and game content is the platform's own generator output |

## Limitations

- Stub transport throughout (see the claim table): the workflow
  machinery — team selection, orchestration, gates, environment
  contract, playability verdict — is what F7 proves.
- The contract build step reports `skipped` for the static HTML5
  game (no bundle entry point); the workflow surfaces this rather
  than manufacturing a build success.
- The playability checker gates the generated HTML5 platformer shape
  (a `game.js` exporting its simulation core); a package without that
  core is refused as not playable, never guessed at.
- The environment cycle is proven on the web adapter; a desktop-side
  game cycle (the WinForms build through the desktop adapter) belongs
  to the desktop workflow (F11) and is not claimed here.
- Full test suite not re-run (30+ min on this VM); the batches above
  cover every touched surface.
