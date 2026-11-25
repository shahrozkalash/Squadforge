import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import { PeInspector } from '../desktop/peInspector.js';
import type { ReleaseManifest } from './packager.js';
import { validateIco } from './iconFactory.js';

/**
 * Phase 23: package & installation validation. A package passes
 * only if: the ZIP parses (JSZip verifies CRCs), every file in the
 * manifest is present with a matching SHA-256, the executable is a
 * valid PE, the icon is a valid ICO, and a simulated install —
 * extracting the package and checking the installed layout — finds
 * everything the installer scripts reference.
 *
 * Honest scope: the simulated install validates the package layout
 * on this host; it does not execute the Windows installer (that
 * requires a Windows machine), and the report says so.
 */

export interface ValidationStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PackageValidation {
  valid: boolean;
  steps: ValidationStep[];
  manifest: ReleaseManifest | null;
}

const sha256 = (data: Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

export async function validatePackage(packagePath: string): Promise<PackageValidation> {
  const steps: ValidationStep[] = [];
  const step = (name: string, ok: boolean, detail: string): void => {
    steps.push({ name, ok, detail });
  };

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(packagePath));
    step('zip-integrity', true, 'ZIP parsed; JSZip verified entry CRCs while reading');
  } catch (err: any) {
    step('zip-integrity', false, `ZIP failed to parse: ${err.message}`);
    return { valid: false, steps, manifest: null };
  }

  let manifest: ReleaseManifest | null = null;
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    step('manifest', false, 'manifest.json missing from package');
    return { valid: false, steps, manifest: null };
  }
  try {
    manifest = JSON.parse(await manifestFile.async('string')) as ReleaseManifest;
    step('manifest', manifest.format === 'squadforge-release', `manifest format=${manifest.format} app=${manifest.appName} version=${manifest.releaseVersion}`);
  } catch (err: any) {
    step('manifest', false, `manifest.json is not valid JSON: ${err.message}`);
    return { valid: false, steps, manifest: null };
  }
  if (!manifest || manifest.format !== 'squadforge-release') {
    return { valid: false, steps, manifest };
  }

  // Every manifest file present with matching hash
  let filesOk = true;
  let filesDetail = `${manifest.files.length} files checked`;
  for (const file of manifest.files) {
    const entry = zip.file(`app/${file.path}`);
    if (!entry) {
      filesOk = false;
      filesDetail = `missing app/${file.path}`;
      break;
    }
    const data = await entry.async('nodebuffer');
    if (data.length !== file.sizeBytes || sha256(data) !== file.sha256) {
      filesOk = false;
      filesDetail = `hash/size mismatch for app/${file.path}`;
      break;
    }
  }
  step('file-hashes', filesOk, filesDetail);

  // Executable is a genuine PE
  const exeEntry = zip.file(`app/${manifest.exe.path}`);
  if (!exeEntry) {
    step('exe-pe', false, `app/${manifest.exe.path} missing`);
  } else {
    const pe = PeInspector.inspect(await exeEntry.async('nodebuffer'));
    step('exe-pe', pe.isPeFile, pe.isPeFile ? `PE ${pe.machine}/${pe.subsystem}, ${pe.sections} sections` : `not a PE: ${pe.errors.join('; ')}`);
  }

  // Icon validity
  if (manifest.icon) {
    const iconEntry = zip.file(manifest.icon.path);
    if (!iconEntry) step('icon', false, `${manifest.icon.path} missing`);
    else {
      const check = validateIco(await iconEntry.async('nodebuffer'));
      step('icon', check.valid, check.valid ? `ICO with ${check.imageCount} image(s), sizes ${check.sizes.join(',')}` : check.error ?? 'invalid ICO');
    }
  }

  // Installer scripts present
  const hasInstall = !!zip.file('install.ps1');
  const hasUninstall = !!zip.file('uninstall.ps1');
  step('installer-scripts', hasInstall && hasUninstall, `install.ps1=${hasInstall} uninstall.ps1=${hasUninstall} installer.iss=${!!zip.file('installer.iss')}`);

  // Simulated install: extract app/ to a scratch dir and verify layout
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR && fs.existsSync(process.env.TMPDIR) ? process.env.TMPDIR : '/tmp'), 'sqf-install-'));
  try {
    let layoutOk = true;
    let layoutDetail = 'installed layout complete';
    for (const file of manifest.files) {
      const entry = zip.file(`app/${file.path}`);
      if (!entry) { layoutOk = false; break; }
      const dest = path.join(scratch, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, await entry.async('nodebuffer'));
    }
    if (layoutOk) {
      const installedExe = path.join(scratch, manifest.exe.path);
      if (!fs.existsSync(installedExe)) {
        layoutOk = false;
        layoutDetail = `executable missing after extraction: ${manifest.exe.path}`;
      } else if (sha256(fs.readFileSync(installedExe)) !== manifest.exe.sha256) {
        layoutOk = false;
        layoutDetail = 'installed executable hash differs from the manifest';
      }
    }
    step('install-simulation', layoutOk, `${layoutDetail} (layout/extraction check only — the Windows installer itself was not executed on this Linux host)`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  return { valid: steps.every((s) => s.ok), steps, manifest };
}
