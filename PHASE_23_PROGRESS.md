# Phase 23 Progress — Desktop Release and Distribution

**Status: IMPLEMENTED AND VERIFIED (2026-11-25)** — a complete release
workflow for SquadForge desktop apps: real `dotnet publish`, versioned
ZIP packages with installer scripts and a hash manifest, channels with
rollback, an update feed, package/install validation, and honest
signing support. Limitations at the end.

## What was built

New module `server/release/` (wired at `/api/builds/:id/release`),
building on Phase 18 (desktop projects + PE inspector), Phase 19
(icon rendering) and Phase 22 (secure terminal, Git):

| File | Role |
| --- | --- |
| `versioning.ts` | Semver parse/compare/bump; stamps `<Version>` into the .csproj so binary, package and manifest agree |
| `iconFactory.ts` | Genuine Windows `.ico` generation (PNG-compressed entry rendered with the Phase 19 pixel engine) + structural ICO validation |
| `signing.ts` | Authenticode support: detects a real signer (osslsigncode; the Linux NSS `signtool` is explicitly not accepted), signs only with a provided certificate, and verifies the PE certificate table afterwards. No signer → `unavailable`, never a fabricated signature |
| `packager.ts` | `dotnet publish` (Release, win-x64, framework-dependent or self-contained) via the Phase 22 secure terminal; packages the publish output into a versioned ZIP (JSZip) with the app files, generated icon, `install.ps1`/`uninstall.ps1` (per-user install to %LOCALAPPDATA% + Start Menu shortcut + uninstall registry entry), an Inno Setup script, build log, release notes and a SHA-256 manifest |
| `releaseStore.ts` | Versioned store: `versions/<version>/` (package, manifest, notes, **preserved build log**), channel pointers, publish/rollback, and an update feed derived from pointer + manifest so it cannot drift from the artifacts |
| `packageValidator.ts` | Validation: ZIP integrity (CRC via JSZip), every manifest file hash-checked, exe PE-verified, icon validated, installer scripts present, and a simulated install (extraction + installed-layout + exe hash check) |
| `releaseRoutes.ts` | `POST /publish` (stamps version, derives notes from real Git history when none given, publishes, packages, stores, validates), `GET /releases`, `GET /feed`, `POST /rollback`, `POST /validate`, `GET /download` — behind the standard auth + ownership checks |

## Verification evidence (2026-11-25, this host)

- **Tests: 7/7 pass** (`tests/phase23_release_distribution.test.ts`):
  semver + csproj stamping; ICO generation/validation and corruption
  rejection; signing honesty (no signer detected on this host,
  `not-requested`/`unavailable` statuses, unsigned PE correctly reads
  as having an empty certificate table); installer script contents;
  **end-to-end**: a Phase 18 FitTrack project → real `dotnet publish`
  → package → store → all validation steps pass → channel feed at
  1.0.0 → publish 1.1.0 → feed moves → **rollback** → feed back at
  1.0.0 → second rollback correctly impossible; packaging refuses a
  directory with no executable; **tamper test**: rewriting a packaged
  DLL makes validation fail at the file-hash step.
- **Reference release numbers** (driver run, same flow): FitTrack.exe
  152,064 bytes, sha256
  `041526279323d91b2f6abfcd54b1968b781ec85921f1947125a80a937d99bf01`
  (the deterministic Phase 18 apphost); package **82,222 bytes**,
  sha256 `c1508a1cb7f9aba789377eeeb44825f40495924d6635b89859787236da321871`,
  5 app files + 233-byte ICO; validation steps all ok:
  zip-integrity, manifest, file-hashes, exe-pe, icon,
  installer-scripts, install-simulation.
- **Lint ✅, TypeScript typecheck ✅, production build ✅.**

## Limitations (honest)

- **Signing is unavailable on this host**: there is no Authenticode
  signer here (no osslsigncode; Microsoft signtool.exe needs the
  Windows SDK; the `signtool` on this Linux PATH is the Mozilla NSS
  tool and cannot sign PEs). Releases therefore record
  `signing.status` as `not-requested` or `unavailable` — with a real
  signer + certificate the same code path signs and then verifies the
  certificate table before claiming `signed`.
- **Installers**: the package ships working PowerShell install/
  uninstall scripts and an Inno Setup script; the Inno `setup.exe`
  itself is only produced by running `iscc` on Windows (not available
  here), and no compiled installer is claimed. Installation
  *validation* is an extraction/layout simulation on this Linux host —
  the Windows installer was not executed here.
- Packages are framework-dependent by default (target machine needs
  the .NET 8 runtime); `selfContained: true` produces the larger
  runtime-bundled variant through the same verified path.
- Update feed is a JSON channel feed (appcast-style); there is no
  in-app auto-updater client in the generated apps yet.
- Release (non-debug) `dotnet publish` only — no MSIX/MSI formats.
