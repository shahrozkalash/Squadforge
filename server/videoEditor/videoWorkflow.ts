import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type {
  CanonicalProjectType,
  CategoryTeamDefinition,
  ResolvedCategoryTeam
} from '../types.js';
import { CategoryTeamRegistry } from '../swarm/categoryTeams.js';
import { createEnvironment } from '../environment/index.js';
import type {
  EnvironmentArtifact,
  EnvironmentBuildResult,
  EnvironmentTestResult
} from '../environment/index.js';
import { deserializeVideoProject, timelineDuration } from './timeline.js';
import { defaultExportSettings, exportVideo } from './videoExporter.js';
import { detectFfmpeg, importMedia, probeMedia } from './mediaProbe.js';
import type { MediaAsset } from './types.js';
import { VideoProjectGenerator } from './videoProjectGenerator.js';

const execFileAsync = promisify(execFile);

/**
 * Factory Phase F8 — the Video Editors workflow.
 *
 * A described video editor flows through the factory machinery as
 * one workflow, on the surfaces the earlier Factory phases
 * established (the F7 games workflow is the pattern):
 *
 *   description → team by data        (F5: CategoryTeamRegistry)
 *               → swarm build         (F2–F4 chain; the build's tree
 *                                      is the editor project package:
 *                                      a serialized VideoProject, its
 *                                      media manifest, the generated
 *                                      editor app's manifest, and the
 *                                      package's own tests)
 *               → environment cycle   (F6 contract, web adapter)
 *               → export verification (this module: the delivered
 *                                      editor project is rendered by
 *                                      the platform's genuine ffmpeg
 *                                      exporter and the MP4 is proven
 *                                      by ffprobe + decoded-frame
 *                                      pixels + audio RMS — the
 *                                      Phase 37 evidence style)
 *
 * The deliverable is an editor *project package*, not a claim that a
 * model wrote an editor from nothing: the ClipForge-class editor
 * application itself is produced by the platform's own generator
 * (`generateEditorApp`, the Phase 20/26/31 generator), and the media
 * the project edits are fixture media, materialized from the
 * package's media manifest by ffmpeg's lavfi sources at verification
 * time (the same way every Phase 20–37 suite creates its media). The
 * editing decisions — clips, crossfade, title, timeline — are the
 * delivered project's own data, and they are what the export
 * verification renders.
 */
export interface VideoEditorWorkflowPlan {
  description: string;
  category: CanonicalProjectType;
  teamName: string;
  profileId: CategoryTeamDefinition['profileId'];
  team: CategoryTeamDefinition;
  resolvedTeam: ResolvedCategoryTeam;
}

export interface VideoWorkflowCycle {
  projectId: string;
  environment: 'web';
  build: EnvironmentBuildResult;
  tests: EnvironmentTestResult;
  previewMode: string;
  artifact: EnvironmentArtifact;
  files: Array<{ path: string; content: string }>;
}

export interface VideoExportCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VideoExportVerification {
  verified: boolean;
  checks: VideoExportCheck[];
  exportPath?: string;
  expectedDurationSec?: number;
  probedDurationSec?: number;
}

/** One fixture-media entry of a package's media/media-manifest.json. */
export interface MediaFixtureEntry {
  /** Package-relative media path, matching the project's asset path. */
  path: string;
  /** ffmpeg arguments (everything except the output path, appended last). */
  ffmpegArgs: string[];
}

export class VideoEditorWorkflow {
  /**
   * Step 1: resolve the creative team for an editor description from
   * the F5 registry data. Throws CategoryTeamResolutionError on
   * dangling data — an editor request never silently falls back.
   */
  static plan(description: string): VideoEditorWorkflowPlan {
    const team = CategoryTeamRegistry.selectForRequest(description);
    const resolvedTeam = CategoryTeamRegistry.resolve(team);
    return {
      description,
      category: team.category,
      teamName: team.displayName,
      profileId: team.profileId,
      team,
      resolvedTeam
    };
  }

  /**
   * The ClipForge-class editor application for this workflow,
   * produced by the platform's own Phase 20/26/31 generator. The
   * generated app's compile evidence is those phases' genuine
   * dotnet builds; the workflow asserts the generated file set.
   */
  static generateEditorApp(appName = 'ClipForge'): Record<string, string> {
    return VideoProjectGenerator.generateProjectFiles(VideoProjectGenerator.getDefaultConfig(appName));
  }

  /**
   * The F6 environment cycle for a built editor project package:
   * open, build, test, preview, export through contract operations
   * only, and read the delivered files back through the contract.
   */
  static async runEnvironmentCycle(input: {
    projectId: string;
    userId: string;
    title: string;
  }): Promise<VideoWorkflowCycle> {
    const env = createEnvironment('web', { userId: input.userId });
    await env.openProject({ projectId: input.projectId, title: input.title });

    const build = await env.build(input.projectId);
    const tests = await env.runTests(input.projectId);
    const preview = await env.preview(input.projectId);
    const exported = await env.exportArtifact(input.projectId);

    const files: Array<{ path: string; content: string }> = [];
    for (const filePath of await env.listFiles(input.projectId)) {
      const content = await env.readFile(input.projectId, filePath);
      if (content !== null) files.push({ path: filePath, content });
    }

    return {
      projectId: input.projectId,
      environment: 'web',
      build,
      tests,
      previewMode: preview.mode,
      artifact: exported.artifact,
      files
    };
  }

  /**
   * The category verification gate: render the delivered editor
   * project with the platform's genuine exporter and prove the MP4.
   *
   * `packageDir` holds the delivered package on disk
   * (project/video-project.json + media/media-manifest.json). Fixture
   * media named by the manifest are materialized with ffmpeg lavfi
   * when absent, then re-probed: the catalogued asset metadata must
   * match the real files before anything renders on their authority.
   * The rendered MP4 is verified by ffprobe (codec, dimensions,
   * duration, audio stream), by decoding real frames (clip colour,
   * crossfade blend, burned-in title pixels) and by measuring the
   * audio track's RMS level. Any failure is a named check in the
   * report — this gate never throws for a bad deliverable, it
   * refuses it.
   */
  static async verifyExport(packageDir: string): Promise<VideoExportVerification> {
    const checks: VideoExportCheck[] = [];
    const check = (name: string, passed: boolean, detail: string) => {
      checks.push({ name, passed, detail });
    };
    const finish = (extra?: Partial<VideoExportVerification>): VideoExportVerification => ({
      verified: checks.every((c) => c.passed),
      checks,
      ...extra
    });

    const ffmpeg = detectFfmpeg();
    if (!ffmpeg) {
      check('ffmpeg available', false, 'ffmpeg not found on this host; the export cannot be rendered or verified');
      return finish();
    }
    check('ffmpeg available', true, ffmpeg);

    // 1. The delivered editor project parses and validates.
    let project: ReturnType<typeof deserializeVideoProject>['project'];
    let serializedAssets: MediaAsset[];
    try {
      const raw = fs.readFileSync(path.join(packageDir, 'project', 'video-project.json'), 'utf-8');
      const parsed = deserializeVideoProject(JSON.parse(raw));
      project = parsed.project;
      serializedAssets = [...parsed.mediaAssets.values()];
      check('editor project parses and validates', true, `${project.tracks.length} tracks, ${project.transitions.length} transitions, ${project.texts?.length ?? 0} text elements`);
    } catch (e: any) {
      check('editor project parses and validates', false, e?.message || String(e));
      return finish();
    }

    // 2. Fixture media materialize and probe as catalogued.
    let manifest: MediaFixtureEntry[];
    try {
      const raw = fs.readFileSync(path.join(packageDir, 'media', 'media-manifest.json'), 'utf-8');
      manifest = (JSON.parse(raw).files ?? []) as MediaFixtureEntry[];
      if (manifest.length === 0) throw new Error('media manifest lists no files');
    } catch (e: any) {
      check('media manifest readable', false, e?.message || String(e));
      return finish();
    }
    const mediaAssets = new Map<string, MediaAsset>();
    try {
      for (const entry of manifest) {
        const target = path.join(packageDir, entry.path);
        if (!fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          await execFileAsync(ffmpeg, [...entry.ffmpegArgs, target], { timeout: 120_000 });
        }
      }
      for (const asset of serializedAssets) {
        const entry = manifest.find((m) => m.path === asset.path);
        if (!entry) throw new Error(`project media "${asset.path}" is not listed in the media manifest`);
        const probed = await importMedia(path.join(packageDir, asset.path));
        if (Math.abs(probed.durationSec - asset.durationSec) > 0.15) {
          throw new Error(
            `media "${asset.path}" probes at ${probed.durationSec.toFixed(3)}s but the project catalogues ${asset.durationSec}s`
          );
        }
        if (probed.width !== asset.width || probed.height !== asset.height) {
          throw new Error(
            `media "${asset.path}" probes at ${probed.width}x${probed.height} but the project catalogues ${asset.width}x${asset.height}`
          );
        }
        probed.id = asset.id;
        mediaAssets.set(asset.id, probed);
      }
      check('fixture media materialize and probe as catalogued', true, `${manifest.length} media files probed and rebound by id`);
    } catch (e: any) {
      check('fixture media materialize and probe as catalogued', false, e?.message || String(e));
      return finish();
    }

    // 3. The genuine export renders.
    const exportPath = path.join(packageDir, 'export.mp4');
    const expectedDurationSec = timelineDuration(project);
    const result = await exportVideo(project, mediaAssets, defaultExportSettings(project), exportPath, {
      timeoutMs: 300_000
    });
    if (result.status !== 'success') {
      check('genuine ffmpeg export succeeds', false, result.error || 'export failed without an error message');
      return finish({ expectedDurationSec });
    }
    check('genuine ffmpeg export succeeds', true, `rendered to ${path.basename(exportPath)}`);

    // 4. ffprobe: streams, dimensions, duration.
    let probedDurationSec = 0;
    try {
      const probe = await probeMedia(exportPath);
      probedDurationSec = probe.durationSec;
      check('export probes as H.264 video', probe.videoCodec === 'h264', `video codec ${probe.videoCodec}`);
      check(
        'export dimensions match the project',
        probe.width === project.width && probe.height === project.height,
        `${probe.width}x${probe.height} vs project ${project.width}x${project.height}`
      );
      check(
        'export duration matches the timeline',
        Math.abs(probe.durationSec - expectedDurationSec) <= 0.35,
        `probed ${probe.durationSec.toFixed(3)}s vs timeline ${expectedDurationSec.toFixed(3)}s`
      );
      check('export carries an audio stream', probe.hasAudio === true, `audio codec ${probe.audioCodec ?? 'none'}`);
    } catch (e: any) {
      check('export probes', false, e?.message || String(e));
      return finish({ exportPath, expectedDurationSec });
    }

    // 5. Decoded frames: first-clip colour, crossfade blend, title.
    try {
      const frameA = await decodeFrame(ffmpeg, exportPath, 0.5, project.width, project.height);
      const meanA = meanColor(frameA);
      check(
        'frame in the first clip shows its colour',
        meanA.r > 150 && meanA.b < 90,
        `mean RGB at 0.5s = ${meanA.r.toFixed(1)}, ${meanA.g.toFixed(1)}, ${meanA.b.toFixed(1)} (solid red clip)`
      );
      const titlePixels = countNearWhite(frameA, project.width, 0, 60);
      check('burned-in title renders visible pixels', titlePixels > 30, `${titlePixels} near-white pixels in the title band at 0.5s`);

      const transition = project.transitions[0];
      if (transition) {
        const base = project.tracks.find((t) => t.kind === 'video');
        const outgoing = base?.clips.find((c) => c.id === transition.afterClipId);
        if (outgoing) {
          const mid = outgoing.trackStart + (outgoing.sourceOut - outgoing.sourceIn) / (outgoing.speed ?? 1) - transition.durationSec / 2;
          const frameMid = await decodeFrame(ffmpeg, exportPath, mid, project.width, project.height);
          const meanMid = meanColor(frameMid);
          check(
            'crossfade midpoint blends both clips',
            meanMid.r > 70 && meanMid.b > 70,
            `mean RGB at crossfade midpoint ${mid.toFixed(2)}s = ${meanMid.r.toFixed(1)}, ${meanMid.g.toFixed(1)}, ${meanMid.b.toFixed(1)} (red→blue blend)`
          );
        }
      }
    } catch (e: any) {
      check('decoded frame verification', false, e?.message || String(e));
    }

    // 6. Audio: the mixed tone track is really there (RMS level).
    try {
      const rms = await measureAudioRmsDb(ffmpeg, exportPath);
      check('exported audio has real signal (RMS)', rms > -45, `peak RMS level ${rms.toFixed(1)} dB`);
    } catch (e: any) {
      check('exported audio has real signal (RMS)', false, e?.message || String(e));
    }

    return finish({ exportPath, expectedDurationSec, probedDurationSec });
  }
}

/** Decodes one frame of a video file to raw RGB24 bytes. */
async function decodeFrame(
  ffmpeg: string,
  filePath: string,
  atSec: number,
  width: number,
  height: number
): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    ffmpeg,
    ['-ss', atSec.toFixed(3), '-i', filePath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { timeout: 60_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }
  );
  const frame = stdout as unknown as Buffer;
  const expected = width * height * 3;
  if (frame.length < expected) {
    throw new Error(`decoded frame at ${atSec}s has ${frame.length} bytes, expected ${expected}`);
  }
  return frame.subarray(0, expected);
}

function meanColor(frame: Buffer): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = frame.length / 3;
  for (let i = 0; i < frame.length; i += 3) {
    r += frame[i];
    g += frame[i + 1];
    b += frame[i + 2];
  }
  return { r: r / pixels, g: g / pixels, b: b / pixels };
}

/** Counts near-white pixels in a horizontal band of the frame. */
function countNearWhite(frame: Buffer, width: number, y0: number, y1: number): number {
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (frame[i] > 200 && frame[i + 1] > 200 && frame[i + 2] > 200) count++;
    }
  }
  return count;
}

/** Peak RMS level (dB) of the audio track, via ffmpeg's astats. */
async function measureAudioRmsDb(ffmpeg: string, filePath: string): Promise<number> {
  let stderr = '';
  try {
    const result = await execFileAsync(ffmpeg, ['-i', filePath, '-af', 'astats=metadata=1', '-f', 'null', '-'], {
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024
    });
    stderr = (result.stderr as any)?.toString() ?? '';
  } catch (e: any) {
    // ffmpeg writes its report to stderr and may exit non-zero for
    // reasons unrelated to the measurement; the report is the data.
    stderr = e?.stderr?.toString() ?? '';
    if (!stderr) throw e;
  }
  // ffmpeg 8 astats prints "RMS level dB: -21.15" per channel.
  const matches = [...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/g)].map((m) =>
    m[1] === '-inf' ? -Infinity : Number(m[1])
  );
  if (matches.length === 0) throw new Error('astats produced no RMS level reading');
  return Math.max(...matches);
}
