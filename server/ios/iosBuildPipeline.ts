import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sanitizeWorkspacePath } from '../pathSecurity.js';
import {
  IosArtifact,
  IosBuildLogEntry,
  IosBuildResult,
  IosDiagnostic,
  IosEnvironment,
  IosProjectConfig
} from './types.js';

const WORKSPACE_ROOT = path.resolve(process.cwd(), '.ios_workspaces');
const ARTIFACT_ROOT = path.resolve(process.cwd(), '.ios_artifacts');
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: `${stdout ?? ''}\n${stderr ?? ''}` });
    });
  });
}

/** Parse xcodebuild's `path:line:col: error|warning: message` diagnostic lines. */
export function parseXcodeDiagnostics(output: string): IosDiagnostic[] {
  const diagnostics: IosDiagnostic[] = [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?):(\d+)(?::(\d+))?:\s+(error|warning|note):\s+(.*)$/);
    if (!match) continue;
    const severity = match[4] === 'error' ? 'error' : match[4] === 'warning' ? 'warning' : 'info';
    const diag: IosDiagnostic = {
      severity,
      file: match[1],
      line: Number(match[2]),
      column: match[3] ? Number(match[3]) : undefined,
      message: match[5].trim()
    };
    const key = `${diag.file}:${diag.line}:${diag.column}:${diag.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(diag);
    }
  }
  return diagnostics;
}

/**
 * Phase 25 — iOS build pipeline.
 *
 * Native iOS compilation is only possible on macOS with Xcode. On any
 * other host this pipeline reports `environment-unavailable` with the
 * exact reason — it NEVER reports success and NEVER fabricates an
 * .app or .ipa. On macOS it drives the real `xcodebuild`, parses its
 * diagnostics, and harvests the genuine .app from DerivedData.
 *
 * IPA export additionally requires a development team (signing). With
 * no team configured the build still compiles unsigned
 * (CODE_SIGNING_ALLOWED=NO) and the IPA step is reported as skipped —
 * never faked.
 */
export class IosBuildPipeline {
  static async detectEnvironment(): Promise<IosEnvironment> {
    const platform = process.platform;
    if (platform !== 'darwin') {
      return {
        platform,
        isMac: false,
        xcodeVersion: null,
        reason: `Native iOS builds require macOS with Xcode; this host runs '${platform}'. Use a macOS machine or a macOS CI runner (see .github/workflows/phase25-ios-verify.yml).`
      };
    }
    const version = await run('xcodebuild', ['-version'], process.cwd(), 30_000);
    if (version.code !== 0) {
      return { platform, isMac: true, xcodeVersion: null, reason: 'macOS detected but `xcodebuild -version` failed — Xcode is not installed or not selected (xcode-select).' };
    }
    const firstLine = version.output.split('\n').find((l) => l.startsWith('Xcode')) ?? 'Xcode (unknown version)';
    return { platform, isMac: true, xcodeVersion: firstLine.trim(), reason: null };
  }

  /** What simulator/device workflows this host supports, stated honestly. */
  static async describeRuntimeSupport(): Promise<{ environment: IosEnvironment; simulator: string; device: string }> {
    const environment = await IosBuildPipeline.detectEnvironment();
    if (!environment.isMac || !environment.xcodeVersion) {
      return {
        environment,
        simulator: 'Unavailable: iOS Simulator ships with Xcode on macOS only.',
        device: 'Unavailable: device builds require macOS, Xcode, and a paired device with signing.'
      };
    }
    return {
      environment,
      simulator: 'Supported on this Mac via `xcrun simctl` (boot, install, launch by bundle ID).',
      device: 'Supported on this Mac when a development team is configured for signing and a device is paired in Xcode.'
    };
  }

  static async build(
    buildId: string,
    config: IosProjectConfig,
    files: Record<string, string>,
    opts: { destination?: 'simulator' | 'generic'; exportIpa?: boolean } = {}
  ): Promise<IosBuildResult> {
    const started = Date.now();
    const logs: IosBuildLogEntry[] = [];
    const log = (level: IosBuildLogEntry['level'], step: string, message: string): void => {
      logs.push({ timestamp: Date.now(), level, step, message });
    };
    const destination = opts.destination ?? 'simulator';
    const environment = await IosBuildPipeline.detectEnvironment();
    log('INFO', 'ENV', environment.xcodeVersion ? `macOS with ${environment.xcodeVersion}` : `host platform: ${environment.platform}`);

    if (!environment.isMac || !environment.xcodeVersion) {
      log('ERROR', 'ENV', environment.reason ?? 'macOS/Xcode unavailable');
      return {
        buildId,
        status: 'environment-unavailable',
        durationMs: Date.now() - started,
        destination,
        environment,
        logs,
        diagnostics: [],
        artifacts: [],
        ipaNote: opts.exportIpa ? 'IPA export not attempted: no macOS/Xcode environment, and no IPA is fabricated.' : null,
        error: environment.reason
      };
    }

    // --- macOS path: genuine xcodebuild ---
    const workspace = path.join(WORKSPACE_ROOT, buildId);
    const derivedData = path.join(workspace, 'DerivedData');
    try {
      fs.mkdirSync(workspace, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        const checked = sanitizeWorkspacePath(workspace, rel);
        if (!checked.valid || !checked.absolutePath) throw new Error(`unsafe project path: ${rel}`);
        fs.mkdirSync(path.dirname(checked.absolutePath), { recursive: true });
        // Binary convention: the app icon PNG travels as base64.
        if (rel.endsWith('.png')) fs.writeFileSync(checked.absolutePath, Buffer.from(content, 'base64'));
        else fs.writeFileSync(checked.absolutePath, content);
      }
      log('INFO', 'WRITE', `Wrote ${Object.keys(files).length} project files to the isolated build workspace`);

      const projectPath = `${config.moduleName}.xcodeproj`;
      const list = await run('xcodebuild', ['-list', '-project', projectPath], workspace, 120_000);
      if (list.code !== 0) {
        const diagnostics = parseXcodeDiagnostics(list.output);
        log('ERROR', 'LIST', '`xcodebuild -list` rejected the project');
        return { buildId, status: 'failed', durationMs: Date.now() - started, destination, environment, logs, diagnostics, artifacts: [], ipaNote: null, error: 'xcodebuild -list failed; see diagnostics/output' };
      }
      log('INFO', 'LIST', 'xcodebuild accepted the project and listed its schemes');

      const destinationArg = destination === 'simulator' ? 'generic/platform=iOS Simulator' : 'generic/platform=iOS';
      const build = await run(
        'xcodebuild',
        [
          '-project', projectPath,
          '-scheme', config.moduleName,
          '-destination', destinationArg,
          '-derivedDataPath', derivedData,
          'CODE_SIGNING_ALLOWED=NO',
          'build'
        ],
        workspace,
        BUILD_TIMEOUT_MS
      );
      const diagnostics = parseXcodeDiagnostics(build.output);
      fs.writeFileSync(path.join(workspace, 'xcodebuild.log'), build.output);
      if (build.code !== 0) {
        log('ERROR', 'BUILD', `xcodebuild exited ${build.code} with ${diagnostics.filter((d) => d.severity === 'error').length} error(s)`);
        return { buildId, status: 'failed', durationMs: Date.now() - started, destination, environment, logs, diagnostics, artifacts: [], ipaNote: null, error: 'xcodebuild build failed; see diagnostics' };
      }
      log('INFO', 'BUILD', 'xcodebuild build succeeded (unsigned, CODE_SIGNING_ALLOWED=NO)');

      // Harvest the genuine .app from DerivedData.
      const productsDir = path.join(derivedData, 'Build', 'Products');
      const configDir = fs.readdirSync(productsDir).find((d) => d.includes('iphonesimulator') || d === 'Debug');
      const appPath = configDir ? path.join(productsDir, configDir, `${config.moduleName}.app`) : null;
      const artifacts: IosArtifact[] = [];
      if (appPath && fs.existsSync(appPath)) {
        const executable = path.join(appPath, config.moduleName);
        const exeBuffer = fs.existsSync(executable) ? fs.readFileSync(executable) : Buffer.alloc(0);
        const artifactDir = path.join(ARTIFACT_ROOT, buildId);
        fs.mkdirSync(artifactDir, { recursive: true });
        const dest = path.join(artifactDir, `${config.moduleName}.app`);
        fs.cpSync(appPath, dest, { recursive: true });
        artifacts.push({
          filename: `${config.moduleName}.app`,
          kind: 'app',
          sizeBytes: exeBuffer.length,
          sha256: createHash('sha256').update(exeBuffer).digest('hex')
        });
        log('INFO', 'HARVEST', `Harvested ${config.moduleName}.app (main executable ${exeBuffer.length} bytes)`);
      } else {
        log('ERROR', 'HARVEST', 'Build reported success but no .app was found in DerivedData — treating as failed');
        return { buildId, status: 'failed', durationMs: Date.now() - started, destination, environment, logs, diagnostics, artifacts: [], ipaNote: null, error: 'no .app produced' };
      }

      // IPA export: only with a signing team; never fabricated.
      let ipaNote: string | null = null;
      if (opts.exportIpa) {
        if (!config.teamId) {
          ipaNote = 'IPA export skipped: no development team configured. An IPA requires signing (team + certificate + provisioning profile) managed by Xcode; the unsigned .app above is the genuine artifact.';
          log('WARN', 'IPA', ipaNote);
        } else {
          // Genuine attempt: archive with the team, then -exportArchive.
          // Certificates/profiles live in the Mac's keychain (Xcode-managed);
          // SquadForge stores none of them.
          const archivePath = path.join(workspace, `${config.moduleName}.xcarchive`);
          const exportDir = path.join(workspace, 'Export');
          const exportOptions = path.join(workspace, 'ExportOptions.plist');
          fs.writeFileSync(
            exportOptions,
            [
              '<?xml version="1.0" encoding="UTF-8"?>',
              '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
              '<plist version="1.0">',
              '<dict>',
              '\t<key>method</key>',
              '\t<string>development</string>',
              `\t<key>teamID</key>`,
              `\t<string>${config.teamId}</string>`,
              '\t<key>signingStyle</key>',
              '\t<string>automatic</string>',
              '\t<key>stripSwiftSymbols</key>',
              '\t<true/>',
              '\t<key>compileBitcode</key>',
              '\t<false/>',
              '</dict>',
              '</plist>',
              ''
            ].join('\n')
          );
          const archive = await run(
            'xcodebuild',
            ['-project', projectPath, '-scheme', config.moduleName, '-destination', 'generic/platform=iOS', '-archivePath', archivePath, 'archive'],
            workspace,
            BUILD_TIMEOUT_MS
          );
          if (archive.code !== 0) {
            ipaNote = 'IPA export failed at the archive step (usually missing signing assets in the keychain); the unsigned simulator .app remains the genuine artifact. See xcodebuild.log.';
            log('ERROR', 'IPA', ipaNote);
          } else {
            const exported = await run(
              'xcodebuild',
              ['-exportArchive', '-archivePath', archivePath, '-exportPath', exportDir, '-exportOptionsPlist', exportOptions],
              workspace,
              BUILD_TIMEOUT_MS
            );
            const ipaPath = path.join(exportDir, `${config.moduleName}.ipa`);
            if (exported.code === 0 && fs.existsSync(ipaPath)) {
              const ipaBuffer = fs.readFileSync(ipaPath);
              artifacts.push({
                filename: `${config.moduleName}.ipa`,
                kind: 'ipa',
                sizeBytes: ipaBuffer.length,
                sha256: createHash('sha256').update(ipaBuffer).digest('hex')
              });
              ipaNote = 'IPA exported and signed by Xcode with the configured team.';
              log('INFO', 'IPA', `Exported ${config.moduleName}.ipa (${ipaBuffer.length} bytes)`);
            } else {
              ipaNote = 'IPA export failed at the -exportArchive step (signing/provisioning); no IPA was produced or fabricated. See xcodebuild.log.';
              log('ERROR', 'IPA', ipaNote);
            }
          }
        }
      }

      return { buildId, status: 'success', durationMs: Date.now() - started, destination, environment, logs, diagnostics, artifacts, ipaNote, error: null };
    } catch (err: any) {
      log('ERROR', 'BUILD', err.message || 'build failed');
      return { buildId, status: 'failed', durationMs: Date.now() - started, destination, environment, logs, diagnostics: [], artifacts: [], ipaNote: null, error: err.message || 'build failed' };
    }
  }
}
