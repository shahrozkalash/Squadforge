import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import { ReleasePackager, type ReleaseMetadata } from '../release/packager.js';
import { validatePackage, type PackageValidation } from '../release/packageValidator.js';
import { PeInspector } from './peInspector.js';
import type {
  EnvironmentArtifact,
  EnvironmentBuildResult,
  EnvironmentDeploymentValidation,
  EnvironmentTestResult
} from '../environment/index.js';

/**
 * Factory Phase F11 — the desktop delivery gate.
 *
 * The gate is the strongest verification that genuinely exists for
 * a desktop delivery on this host, in two halves:
 *
 *  1. The Linux half is assessed from the F6 desktop environment's
 *     own contract results (see DesktopWorkflow): the
 *     DesktopBuildPipeline build verdict, the apphost `--smoke`
 *     runs (the generated app's headless state-store exercise,
 *     Phase 36), the harvested artifact re-verified as ELF from its
 *     bytes on disk, and the deployment dry-run. Smoke evidence is
 *     only accepted when two consecutive runs report strictly
 *     increasing persisted launch counts — a single SMOKE_OK line
 *     proves the app started; the second run proves its state
 *     store genuinely persists between launches (the Phase 36/60
 *     evidence style).
 *
 *  2. The Windows half is produced here, by the platform's own
 *     release system (Phase 23): the described app's Windows
 *     variant (the DesktopProjectGenerator's WinForms output for
 *     the same app identity) is materialized into a scratch
 *     workspace and driven through ReleasePackager.publishProject
 *     (a genuine `dotnet publish -r win-x64`), packageRelease
 *     (SHA-256 manifest, PE-verified exe entry, honest signing
 *     status) and validatePackage — and then tampered with, to
 *     prove the validator's file-hash step actually detects a
 *     modified packaged file. The Windows exe is PE-verified, never
 *     executed: a Windows GUI binary cannot run on this Linux host
 *     (Phases 18/23/57 platform record), and the gate claims
 *     publish + package evidence only.
 */

export interface DesktopGateCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface WindowsPackageReport {
  /** dotnet publish ran and produced the app exe. */
  published: boolean;
  /** The published exe parsed as a genuine PE file. */
  exePeVerified: boolean;
  exeSizeBytes: number;
  /** Files in the release manifest, each with a SHA-256. */
  manifestFileCount: number;
  manifestAllHashed: boolean;
  /** The packaged ZIP's SHA-256, as recorded by the packager. */
  packageSha256: string;
  packageSizeBytes: number;
  /** validatePackage verdict on the untouched package. */
  validation: PackageValidation | null;
  /** A byte-tampered copy of the package was rejected at the file-hashes step. */
  tamperDetected: boolean;
  tamperDetail: string;
  /** The packager's recorded signing status (honest, never fabricated). */
  signingStatus: string;
  detail: string;
}

export interface DesktopDeliveryEvidence {
  build: EnvironmentBuildResult;
  /** Consecutive contract runTests results (compile + smoke). */
  smokeRuns: EnvironmentTestResult[];
  /** Persisted LaunchCount parsed from each smoke run's detail, in order. */
  launchCounts: number[];
  artifact: EnvironmentArtifact;
  /** The exported artifact's bytes re-inspected as ELF on disk. */
  artifactElfOk: boolean;
  deploymentDryRun: EnvironmentDeploymentValidation;
  windowsPackage: WindowsPackageReport;
}

export interface DesktopGateReport {
  passed: boolean;
  checks: DesktopGateCheck[];
  launchCounts: number[];
  windowsPackage: WindowsPackageReport;
}

/**
 * Assesses one desktop delivery from its evidence. Every check is
 * derived from the evidence records themselves — a failed build, a
 * smoke run that did not persist state, a non-ELF artifact, an
 * invalid dry-run, or a Windows package that fails validation (or
 * whose tampering goes undetected) each fail the gate by name.
 */
export function assessDesktopDelivery(evidence: DesktopDeliveryEvidence): DesktopGateReport {
  const checks: DesktopGateCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  check(
    'pipeline-build',
    evidence.build.status === 'succeeded',
    evidence.build.status === 'succeeded'
      ? evidence.build.detail
      : `DesktopBuildPipeline build did not succeed (status=${evidence.build.status}): ${evidence.build.error || evidence.build.detail}`
  );

  const smokeOk =
    evidence.smokeRuns.length >= 2 &&
    evidence.smokeRuns.every(r => r.status === 'passed' && r.mode === 'compile_and_smoke');
  check(
    'smoke-runs',
    smokeOk,
    evidence.smokeRuns.map(r => `[${r.status}/${r.mode}] ${r.detail}`).join(' | ') ||
      'no smoke runs recorded'
  );

  const counts = evidence.launchCounts;
  const persisted =
    counts.length >= 2 && counts.every((c, i) => i === 0 || c > counts[i - 1]);
  check(
    'smoke-state-persistence',
    persisted,
    counts.length >= 2
      ? `Persisted LaunchCount across consecutive apphost runs: ${counts.join(' -> ')}`
      : `expected at least two smoke runs with persisted launch counts, got [${counts.join(', ')}]`
  );

  check(
    'artifact-elf',
    evidence.artifact.sizeBytes > 0 && !!evidence.artifact.sha256 && evidence.artifactElfOk,
    evidence.artifactElfOk
      ? `Exported artifact ${evidence.artifact.name} (${evidence.artifact.sizeBytes} bytes, sha256 ${evidence.artifact.sha256}) re-verified as a genuine ELF executable from its bytes on disk.`
      : `Exported artifact ${evidence.artifact.name} failed ELF re-verification or carries no hash.`
  );

  check(
    'deployment-dry-run',
    evidence.deploymentDryRun.valid === true,
    evidence.deploymentDryRun.valid
      ? evidence.deploymentDryRun.detail
      : `Deployment dry-run reported defects: ${evidence.deploymentDryRun.defects.join('; ')}`
  );

  const win = evidence.windowsPackage;
  check(
    'windows-publish',
    win.published && win.exePeVerified,
    win.detail
  );
  check(
    'windows-package-validation',
    win.validation?.valid === true && win.manifestAllHashed && win.manifestFileCount > 0,
    win.validation
      ? `validatePackage: valid=${win.validation.valid}; steps: ${win.validation.steps.map(s => `${s.name}=${s.ok ? 'ok' : 'FAIL'}`).join(', ')}; manifest files=${win.manifestFileCount} (all SHA-256 hashed: ${win.manifestAllHashed}); signing=${win.signingStatus}.`
      : 'validatePackage did not run.'
  );
  check(
    'windows-package-tamper-detection',
    win.tamperDetected,
    win.tamperDetail
  );

  return {
    passed: checks.every(c => c.ok),
    checks,
    launchCounts: counts,
    windowsPackage: win
  };
}

/**
 * Produces the Windows half of the gate: publishes, packages and
 * validates the described app's Windows variant with the platform's
 * Phase 23 release system, then proves tamper detection on the
 * resulting package. The scratch workspace is left in place for the
 * caller to inspect/remove (the Phase 23 suite pattern).
 */
export async function verifyWindowsPackage(input: {
  windowsFiles: Record<string, string>;
  metadata: ReleaseMetadata;
  scratchRoot: string;
}): Promise<WindowsPackageReport> {
  const workspace = path.join(input.scratchRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  for (const [rel, content] of Object.entries(input.windowsFiles)) {
    const abs = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }

  const packager = new ReleasePackager();
  const { publishDir, buildLog } = await packager.publishProject(workspace, input.metadata);

  const exeName = `${input.metadata.appName}.exe`;
  const exePath = path.join(publishDir, exeName);
  const published = fs.existsSync(exePath);
  const exeBytes = published ? fs.readFileSync(exePath) : Buffer.alloc(0);
  const pe = PeInspector.inspect(exeBytes);

  const packagePath = path.join(workspace, `${input.metadata.appName}-${input.metadata.version}.zip`);
  const result = await packager.packageRelease(publishDir, input.metadata, buildLog, packagePath);
  const validation = await validatePackage(result.packagePath);

  // Tamper evidence: rewrite one packaged file's bytes and require
  // the validator's file-hash step to catch it (Phase 23 test 6.1
  // pattern). The tampered target is the app DLL when the manifest
  // lists one, else the first manifest file.
  const dllEntry = result.manifest.files.find(f => f.path.toLowerCase().endsWith('.dll'));
  const tamperTarget = dllEntry ?? result.manifest.files[0];
  let tamperDetected = false;
  let tamperDetail = 'tamper check did not run';
  if (tamperTarget) {
    const zip = await JSZip.loadAsync(fs.readFileSync(result.packagePath));
    zip.file(`app/${tamperTarget.path}`, 'tampered-content');
    const tamperedPath = path.join(workspace, 'tampered.zip');
    fs.writeFileSync(tamperedPath, await zip.generateAsync({ type: 'nodebuffer' }));
    const tampered = await validatePackage(tamperedPath);
    const hashStep = tampered.steps.find(s => s.name === 'file-hashes');
    tamperDetected = tampered.valid === false && hashStep?.ok === false;
    tamperDetail =
      `Rewrote app/${tamperTarget.path} inside a copy of the package: validatePackage valid=${tampered.valid}, ` +
      `file-hashes step ok=${hashStep?.ok}. ${hashStep?.detail ?? ''}`.trim();
  }

  return {
    published,
    exePeVerified: pe.isPeFile,
    exeSizeBytes: exeBytes.length,
    manifestFileCount: result.manifest.files.length,
    manifestAllHashed: result.manifest.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256)),
    packageSha256: result.packageSha256,
    packageSizeBytes: result.packageSizeBytes,
    validation,
    tamperDetected,
    tamperDetail,
    signingStatus: result.manifest.signing.status,
    detail:
      `ReleasePackager ran a genuine dotnet publish (-r win-x64) of the generated Windows project: ${exeName} ` +
      `${published ? `${exeBytes.length} bytes` : 'MISSING'}, PE-verified=${pe.isPeFile}` +
      (pe.isPeFile ? '' : ` (${pe.errors.join('; ')})`) +
      `. The exe is publish-verified only — a Windows GUI binary cannot execute on this host.`
  };
}
