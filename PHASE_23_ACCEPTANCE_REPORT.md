# Phase 23 Acceptance Report — Desktop Release and Distribution

**Date:** 2026-11-25 · **Verdict: PASS** (with the limitations below)

## Requirement-by-requirement

| Requirement | Evidence |
| --- | --- |
| Real Windows application packages and installers | Real `dotnet publish` output packaged into a versioned ZIP with working PowerShell install/uninstall scripts + an Inno Setup script. No compiled `setup.exe` is claimed (iscc is Windows-only — see limitations); nothing fabricated |
| Application metadata, icons, versioning, configuration | Manifest carries app/publisher/description/channel/runtime; version stamped into the .csproj before publish (test 1.1); genuine generated ICO validated and packaged (test 2.1) |
| Dependencies and runtime requirements | Publish via the real toolchain with RID win-x64; framework-dependent vs self-contained is an explicit, recorded manifest choice (`runtime.selfContained`) |
| Signing support where certificates are available | Signer detection + sign + post-sign certificate-table verification implemented; on this host no Authenticode signer exists, so releases honestly record `unavailable`/`not-requested` (test 3.1). No signature was fabricated |
| Validate packages and installation processes | 7-step validation (ZIP/CRC, manifest, per-file SHA-256, PE, ICO, installer scripts, extraction-based install simulation) — all pass on a real package; tampered package fails at the hash step (test 6.1) |
| Updates, release channels, rollback | Channel pointers + derived update feed; publish 1.0.0 → 1.1.0 moves the feed; rollback returns it to 1.0.0; double rollback rejected (test 5.1) |
| Release documentation | RELEASE_NOTES.md in every package and in the store (caller's notes or generated from the workspace's real Git history via the routes) |
| Preserve build logs and downloadable artifacts | `build.log` stored in the package and per-version in the store; `GET /download` serves stored packages |
| Tests: packaging, artifact validation, versioning, failure recovery | 7/7 pass, including tamper detection and missing-executable refusal |

## Checks run

- `npx tsx --test tests/phase23_release_distribution.test.ts` → **7/7 pass**
  (includes two real `dotnet publish` runs)
- Reference package: 82,222 bytes, sha256
  `c1508a1cb7f9aba789377eeeb44825f40495924d6635b89859787236da321871`;
  validation 7/7 steps ok
- `npm run lint` → ✅ · TypeScript typecheck → ✅ · `npm run build` → ✅

## Limitations

1. No Authenticode signing on this host (no capable signer) — status
   is recorded honestly; the sign + verify path activates where a
   signer and certificate exist.
2. No compiled Inno Setup `setup.exe` (requires Windows `iscc`); the
   package's PowerShell installer is the executable installer here.
3. Install validation is an extraction/layout simulation, not an
   executed Windows install.
4. No MSIX/MSI; no in-app auto-updater client yet.

## Acceptance

Implemented and verified as above. Final acceptance remains the
project owner's decision, per repo convention.
