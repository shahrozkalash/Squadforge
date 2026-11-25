# SquadForge Agent Guide

Last inspected commit: `4e3b8fd` (the last code change, merged to `main`) (2026-11-05). Phases 9, 10, and 11 are accepted by the owner and merged to `main`. Update this with every handoff.

This guide comes from the project owner's reconstructed handoff and from repository inspection. The original AI Studio prompt and chats are unavailable. Treat the handoff as stated intent, and check its claims against the code. When historical evidence is missing, document the uncertainty instead of inventing a decision.

## Product goal

SquadForge should become a genuine collaborative AI software development platform that can plan, build, review, debug, test, and deliver complete software projects. It is not a chatbot that generates isolated snippets.

The intended users include people who may not have the experience to coordinate multiple development tools and agents themselves. The architecture should support different AI providers rather than depending on one model.

Do not sacrifice authorization, project isolation, reliable execution, or honest validation to make the interface look more complete.

## How to work

1. Inspect the existing repository before changing anything.
2. Extend the existing architecture instead of creating duplicate systems.
3. Implement the requested functionality directly, not recommendations or mock interfaces.
4. Add meaningful tests for new functionality.
5. Run lint, tests, and production builds.
6. Document completed work and remaining limitations.
7. Never claim that a feature or test works without verification.

Commands:

```bash
npm run lint    # tsc --noEmit
npm test        # tsx --test tests/**/*.test.ts
npm run build   # vite build
npm run dev     # tsx server.ts
```

Real sandbox tests need Docker: `docker build -t squadforge-sandbox:1 sandbox`, then `SANDBOX_INTEGRATION=1 npx tsx --test tests/phase10_sandbox_integration.test.ts tests/phase10_end_to_end.test.ts tests/phase11_sandbox_repair.test.ts`.

Real model tests need an OpenAI-compatible local server such as Ollama: `LOCAL_MODEL_INTEGRATION=1 npx tsx --test tests/phase11_real_model.test.ts`. They are not run in CI.

Project code must only run through an `ExecutionBackend` with real isolation. Never add a backend that runs it as a plain host process.

## Engineering invariants

These are proposed by the handoff and still need confirming against the code.

1. Approval must be real. Sensitive changes must not be applied before the required authorization.
2. Authorization must be enforced server-side. Frontend controls are not security boundaries.
3. Users and projects must not gain access to another user's private data or workspace.
4. Validation must be evidence-based. Finished generation does not mean a successful project.
5. Failed validation must remain visible behind any status shown to users.
6. Cancellation must stop work, not only update a database status.
7. Secrets must remain server-side. Never expose provider API keys in browser code.
8. File changes must use integrity checks, conflict handling, and safe patch application.
9. Report only tests, builds, and capabilities that have actually been verified.

## Current status

| Area | Status |
| :--- | :--- |
| Phases 1-6 | Original specs unavailable. Reconstruct them from commits, tests, and code, and separate original requirements from inferred behavior. |
| Phase 7 | Universal Software Architecture Engine. `tests/phase7_project_export_verification.test.ts` suggests phase numbering may be inconsistent. |
| Phase 8 | Historically reported as accepted. Not independently re-verified. |
| Phase 9 | Advanced Code Generation Engine. Accepted by the owner on 2026-11-05 at `e87efe8`, with the limitations in `PHASE_9_ACCEPTANCE_REPORT.md`. |
| Phase 10 | Execution environment. Accepted by the owner on 2026-11-05 at `e87efe8`. Off by default and still not ready for production. See `PHASE_10_ACCEPTANCE_REPORT.md`. |
| Phase 11 | Advanced Debugging and Self-Improvement. Accepted by the owner on 2026-11-05 at `708e761`. Most limitations were then fixed, in two rounds. See `PHASE_11_ACCEPTANCE_REPORT.md`. |
| Phase 12 | Automated Testing and Quality Assurance. Implemented and verified on 2026-11-25: file-level test coverage analysis wired into the verification service, a test-output parsing honesty fix, and the `.env.example` keys restored so the CI integrity test passes. Accepted by the owner on 2026-11-25. See `PHASE_12_ACCEPTANCE_REPORT.md`. |
| Phase 13 | Advanced Application Development. Implemented and verified on 2026-11-06. See `PHASE_13_ACCEPTANCE_REPORT.md`. |
| Phase 14 | GitHub and Project Lifecycle. Implemented and verified on 2026-11-06. See `PHASE_14_ACCEPTANCE_REPORT.md`. |
| Phase 15 | Deployment and Distribution. Implemented and verified on 2026-11-06. See `PHASE_15_ACCEPTANCE_REPORT.md`. |
| Phase 16 | Production Readiness and Intelligence. Implemented and verified on 2026-11-06. See `PHASE_16_ACCEPTANCE_REPORT.md`. |
| Phase 17 | Native Android Development Engine. Implemented and verified on 2026-11-06. See `PHASE_17_ACCEPTANCE_REPORT.md`. |
| Phase 18 | Desktop Development Engine (Windows first). Implemented and verified on 2026-11-25, including a genuine local `dotnet build` of a generated project producing a PE-verified Windows `.exe`. See `PHASE_18_ACCEPTANCE_REPORT.md`. |
| Phase 19 | Image Editing Engine. Implemented and verified on 2026-11-25: real pixel/layer/tool engine with PNG/BMP codecs (24/24 tests) plus a generated C# editor app that compiles genuinely via the Phase 18 pipeline. See `PHASE_19_ACCEPTANCE_REPORT.md`. |
| Phase 20 | Video Editing Engine. Implemented and verified on 2026-11-25: multitrack timeline model with validated operations, genuine ffmpeg exports (crossfades, titles, effects, audio mix) validated by ffprobe (15/15 tests), journal-based recovery, plus a generated C# editor app that compiles genuinely. See `PHASE_20_ACCEPTANCE_REPORT.md`. |
| Phase 21 | 3D Creation Engine. Implemented and verified on 2026-11-25: scene graph with primitives/materials/lights/keyframe animation, a genuine z-buffer software renderer (17/17 tests), real OBJ and glTF 2.0 export, plus a generated C# 3D app that compiles genuinely via the Phase 18 pipeline. See `PHASE_21_ACCEPTANCE_REPORT.md`. |
| Phase 22 | Desktop IDE and Development Tools. Implemented and verified on 2026-11-25: syntax tokenizer, workspace file service on the shared path-security layer, secure allowlisted terminal (cwd-locked, no shell), build/run with parsed diagnostics, real Git and npm operations, six project templates, AI assist via the existing LocalLLMService (14/14 tests), plus a generated C# IDE app that compiles genuinely. See `PHASE_22_ACCEPTANCE_REPORT.md`. |
| Phase 23 | Desktop Release and Distribution. Implemented and verified on 2026-11-25: real `dotnet publish` packaging into versioned ZIP releases with installer scripts, generated icons, SHA-256 manifests, channel pointers with rollback and an update feed, 7-step package/install validation with tamper detection (7/7 tests), and honest Authenticode signing support (unavailable on this host, never fabricated). See `PHASE_23_ACCEPTANCE_REPORT.md`. |
| Phase 24 | Game Development Engine. Implemented and verified on 2026-11-25: deterministic fixed-timestep 2D engine (physics/collisions/animation/camera), a complete playable HTML5 platformer whose shipped code is simulated in tests, a compile-verified WinForms 3D game on the Phase 21 stack, procedural WAV audio, asset management, performance profiling (0.0216 ms/step), and an authoritative WebSocket multiplayer foundation with proven cheat resistance (14/14 tests). See `PHASE_24_ACCEPTANCE_REPORT.md`. |
| Phase 26 | Professional Video Editing Engine. Implemented and verified on 2026-11-25: extends Phase 20 in place — real overlay/PiP compositing (ffmpeg overlay filters, z-order, time windows), image layers via looped inputs, clip transforms (position/scale/rotation/opacity/crop), speed with speed-aware timeline math (setpts + atempo), text layers, non-destructive validated edit operations with an authenticated /operations route, ClipForge app extended and genuinely compiled (12/12 phase tests, 15/15 Phase 20 compatibility). See `PHASE_26_ACCEPTANCE_REPORT.md`. |
| Phase 27 | Real-Time Timeline and Playback Engine. Implemented and verified on 2026-11-25: single-clock playback session (play/pause/stop, frame-accurate seeking, 0.25–4x speed, zero-drift A/V sync by construction), one timeline resolver shared by session and preview (trims/speed/crossfade progress exact), real composited preview frames via input-seeked ffmpeg decoding through the exporter's shared transform chain (crossfade midpoints blend genuinely), timeline view state (zoom/scroll/track visibility), explicit error states for missing/corrupted media, authenticated preview routes (13/13 phase tests; 40/40 with Phase 20+26 regression). See `PHASE_27_ACCEPTANCE_REPORT.md`. |
| Phase 28 | Effects, Transitions and Animation Engine. Implemented and verified on 2026-11-25: modular effect registry (brightness/contrast/saturation/temperature/blur/sharpen) with ordered non-destructive stacks shared by export and preview, 8 xfade transition types, keyframe animation for position/scale/rotation/opacity and text position compiled to ffmpeg time expressions from one sampler (preview≡export pixels), ClipForge effect stack compiled genuinely (11/11 phase tests; 51/51 with Phase 20/26/27 regression). Documented limits: scale keyframes step-approximated in export (ffmpeg scale cannot resize mid-stream), text opacity keyframes rejected, no unverified effects offered. See `PHASE_28_ACCEPTANCE_REPORT.md`. |
| Phase 29 | Audio, Captions and AI Editing Engine. Implemented and verified on 2026-11-25: per-track gain/mute and per-clip audio fades in the real mix (PCM-measured), streamed waveform peaks from actual audio, caption track with SRT/VTT import/export and burn-in + preview rendering, configurable caption provider adapter (default none; offline whisper-cli; failures never fabricate), scene/silence analysis with suggested cuts from real ffmpeg signal detection, voiceover upload route (10/10 phase tests; 61/61 with Phase 20/26/27/28 regression). See `PHASE_29_ACCEPTANCE_REPORT.md`. |
| Phase 30 | Rendering and Export Engine. Implemented and verified on 2026-11-25: export presets (source/480p/720p/1080p/4K — real 720p and 4K renders probed), real progress via ffmpeg's -progress channel, cancellation that deletes partial output, background render jobs with persisted state and interrupted-job recovery + retry, probe-verified hardware encoder detection with automatic software fallback (no GPU on this host — detection says so, nothing faked), export history and output management routes (10/10 phase tests; 71/71 with Phase 20/26/27/28/29 regression). See `PHASE_30_ACCEPTANCE_REPORT.md`. |
| Phase 31 | Cross-Platform Professional Video Editor. Implemented and verified on 2026-11-25: web-based editor served per build (media library, real-frame preview player, multitrack timeline, properties panel, export screen — every control wired to the real API), project create/save/load with journal-based recovery and debounced autosave, keyboard shortcuts, responsive layout, ClipForge desktop app gained caption burn-in and recompiled genuinely, complete end-to-end workflow verified over real HTTP with an ffprobe-validated export (1/1 E2E test; 72/72 with Phase 20/26–30 regression). Android/iOS editor NOT claimed. See `PHASE_31_ACCEPTANCE_REPORT.md`. |
| Phase 33 | AI Reliability and Production Security. Implemented and verified on 2026-11-25: provider timeout policy (was a hard-coded 8 s; now `PROVIDER_TIMEOUT_MS`, default 120 s) with genuine request abortion, bounded retries for transient failures only (`PROVIDER_MAX_RETRIES`, default 2), `OPENROUTER_BASE_URL`/`GEMINI_BASE_URL` overrides, a client-side bypass of the production deployment approval gate (`skipApprovalGate` in the request body) found and removed with the Phase 15 route tests moved to the real approval flow, and a redacting structured audit log wired into approvals, deployments, execution sessions, rollbacks and GitHub connections (13/13 phase tests over real HTTP transport stubs; full suite 1,121/1,127 with only the 2 known pre-existing failures plus load flakes that pass in isolation). NOT demonstrated: a successful live cloud repair generation — four genuine attempts via the owner's AI Studio credential returned real 503/404 responses or egress timeouts; the gated live test (`LIVE_PROVIDER_TEST=1`) stands ready. See `PHASE_33_ACCEPTANCE_REPORT.md`. |

Later roadmap:

- Phase 18: Multi-Platform Native Extensions (iOS / Desktop) — desktop half delivered as the Desktop Development Engine above; iOS remains future work.

Do not present GitHub integration or deployment as complete until they are implemented and tested, even where the README lists them. The "production ready" wording in the Phase 8 report does not describe the whole product.

## Known dependency problem

The lockfile was added and deleted repeatedly on `main` before Phase 10, and the cause is unknown. If it disappears, `npm ci` and CI fail. Restore it, and do not regenerate it unless dependencies changed. It was generated on Linux, so Windows builds need the native packages installed locally with `npm i --no-save`.

## Open work

1. Test cancellation against a real provider. (Phase 33: cancellation, timeout and retry behaviour are proven against real HTTP transports for all three provider paths; a live-provider cancellation run is still open.)
2. Run the sandbox tests on a real worker, with TLS and gVisor.
3. Decide on guest execution, the worker, and the preview domain.
4. Have `invariant-reviewer` check the fixes listed under "Fixed after acceptance" in `PHASE_9_ACCEPTANCE_REPORT.md`, and the relay token.
5. Expire approval requests the owner never answers. Repairs already close when theirs expire.
6. Test Phase 11 repairs with a real cloud provider. Only a local model has run so far. (Phase 33: four genuine Gemini attempts via the owner's AI Studio credential returned real 503/404 responses or egress timeouts — reachability proven, a successful generation still not demonstrated. Run `LIVE_PROVIDER_TEST=1` with a real `GEMINI_API_KEY` to close this.)
7. Decide whether the older `/rollback-checkpoint` and `/rollback-file` routes need conflict checks.
8. Decide whether non-sensitive repair rollbacks need approval, and whether to set `REPAIR_AUTO_START`.

## Fragile areas

- Persistent storage and database reliability
- Authentication, authorization, and tenant isolation
- Safe execution of generated code
- Cancellation of active model requests
- Sensitive-file approval
- Integration validation and finalization status
- Reproducible dependency installation
- Long-running generation and frontend progress reporting
- `db.getFile` and `db.getAllFiles` return live objects that change in place on every write. Copy them before holding them across an `await`, or a version check compares a file with itself

## Collaboration

The owner is actively developing the project, and AI Studio or another agent may push to `main`. The handoff proposes this policy:

1. Keep `main` as the stable integration branch.
2. Use a separate branch for each phase or focused task, including AI Studio work.
3. Review the diff and run the required checks before merging.
4. Do not have two agents modify the same files at the same time.
5. Fetch the latest changes before beginning a task.
6. Record the last inspected commit SHA in every handoff.

The project owner keeps final merge approval unless it is explicitly delegated.

### Commit attribution

All work is done on behalf of the project owner, Shahroz. Every commit must use this author and committer identity:

```text
Shahrozkalash <shahrozkalash@gmail.com>
```

Set it for this repository only with `git config --local user.name` and `git config --local user.email`, then confirm it with `git log -1 --format='%an <%ae> | %cn <%ce>'` before pushing. Do not commit under another identity or change global git config.

## Open questions

- **Accounts:** the owner asked to remove signup and login pages, and commit messages mention guest sessions and automatic user provisioning. The README still lists accounts and per-user isolation. The intended model is unconfirmed.
- **Providers:** `server.ts` checks `GEMINI_API_KEY`, but `.env.example` omits it. Inspect actual routing to establish whether OpenRouter is the primary provider, a fallback, or an additional provider.
- **Branding:** visible "Gemini engine" branding should stay out of the UI. Whether this extends to docs is unconfirmed.
- **Deployment:** no production URL, active users, or production database are verified.
- **`server.ts` size:** it is unknown whether this is deliberate. Do not preserve it as an architectural requirement without evidence.
- **First release:** the 11-step definition of done in the handoff is proposed, not approved, and no phase is assigned to it.

Never put secret values in handoffs or in this file. Use variable names only.
