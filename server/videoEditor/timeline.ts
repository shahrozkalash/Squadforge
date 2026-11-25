import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  ClipTransform,
  MediaAsset,
  SerializedVideoProject,
  TimelineClip,
  TimelineTrack,
  TransitionType,
  VideoProject
} from './types.js';
import { mediaKind } from './types.js';
import { validateEffectInstance, validateKeyframes, validateTransitionType } from './effects.js';

/**
 * Phase 20: timeline model operations — pure, validated, and honest.
 * Clips may not overlap on a track (the one exception: on the base
 * video track a clip may overlap its predecessor by exactly the
 * crossfade duration defined on that predecessor). Splitting and
 * trimming keep source offsets consistent with the media.
 */

/** Source span consumed by the clip (seconds of media). */
export function clipSourceDuration(clip: TimelineClip): number {
  return clip.sourceOut - clip.sourceIn;
}

/** Phase 26: timeline duration = source span / speed (speed defaults to 1). */
export function clipDuration(clip: TimelineClip): number {
  return clipSourceDuration(clip) / (clip.speed && clip.speed > 0 ? clip.speed : 1);
}

export function clipSpeed(clip: TimelineClip): number {
  return clip.speed && clip.speed > 0 ? clip.speed : 1;
}

export function clipEnd(clip: TimelineClip): number {
  return clip.trackStart + clipDuration(clip);
}

export function createProject(name: string, width: number = 1280, height: number = 720, fps: number = 30): VideoProject {
  return {
    id: crypto.randomUUID(),
    name,
    width,
    height,
    fps,
    tracks: [
      { id: crypto.randomUUID(), kind: 'video', name: 'Video 1', clips: [] },
      { id: crypto.randomUUID(), kind: 'audio', name: 'Audio 1', clips: [] }
    ],
    transitions: [],
    texts: []
  };
}

export function addTrack(project: VideoProject, kind: 'video' | 'audio', name?: string): TimelineTrack {
  const track: TimelineTrack = {
    id: crypto.randomUUID(),
    kind,
    name: name || `${kind === 'video' ? 'Video' : 'Audio'} ${project.tracks.filter((t) => t.kind === kind).length + 1}`,
    clips: []
  };
  project.tracks.push(track);
  return track;
}

export function getTrack(project: VideoProject, trackId: string): TimelineTrack {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track not found: ${trackId}`);
  return track;
}

export function getClip(project: VideoProject, clipId: string): { track: TimelineTrack; clip: TimelineClip } {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  throw new Error(`Clip not found: ${clipId}`);
}

export function baseVideoTrack(project: VideoProject): TimelineTrack {
  const track = project.tracks.find((t) => t.kind === 'video');
  if (!track) throw new Error('Project has no video track');
  return track;
}

function validateClipAgainstMedia(clip: TimelineClip, media: MediaAsset): void {
  if (clip.sourceIn < 0) throw new Error('sourceIn cannot be negative');
  if (clip.sourceOut <= clip.sourceIn) throw new Error('sourceOut must be after sourceIn');
  // Images loop indefinitely in the exporter, so the media-duration bound does not apply.
  if (mediaKind(media) !== 'image' && clip.sourceOut > media.durationSec + 0.05) {
    throw new Error(`Clip extends past media duration (${clip.sourceOut}s > ${media.durationSec}s)`);
  }
  if (clip.trackStart < 0) throw new Error('trackStart cannot be negative');
  if (clip.volume < 0 || clip.volume > 1) throw new Error('volume must be between 0 and 1');
  if (clip.speed !== undefined && (clip.speed < 0.25 || clip.speed > 4)) {
    throw new Error('speed must be between 0.25 and 4');
  }
  if (clip.transform) validateTransform(clip.transform, media);
}

/** Phase 26: shared transform validation (also used by the editing operations). */
export function validateTransform(t: ClipTransform, media?: MediaAsset): void {
  if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) throw new Error('transform position must be finite');
  if (t.scale < 0.05 || t.scale > 4) throw new Error('transform scale must be between 0.05 and 4');
  if (t.rotationDeg < -360 || t.rotationDeg > 360) throw new Error('transform rotation must be between -360 and 360 degrees');
  if (t.opacity < 0 || t.opacity > 1) throw new Error('transform opacity must be between 0 and 1');
  if (t.crop) {
    const { left, top, right, bottom } = t.crop;
    if ([left, top, right, bottom].some((v) => v < 0)) throw new Error('crop values cannot be negative');
    if (media?.width && left + right >= media.width) throw new Error('crop left+right must be smaller than the source width');
    if (media?.height && top + bottom >= media.height) throw new Error('crop top+bottom must be smaller than the source height');
  }
}

/** Overlap allowance for a clip pair on the base track = crossfade on the earlier clip. */
function allowedOverlap(project: VideoProject, track: TimelineTrack, earlier: TimelineClip): number {
  if (track.id !== baseVideoTrack(project).id) return 0;
  const t = project.transitions.find((tr) => tr.afterClipId === earlier.id);
  return t ? t.durationSec : 0;
}

export function assertNoOverlap(project: VideoProject, track: TimelineTrack, candidate: TimelineClip, ignoreClipId?: string): void {
  const existing = track.clips.filter((c) => c.id !== ignoreClipId);
  const sorted = [...existing, candidate].sort((a, b) => a.trackStart - b.trackStart);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const overlap = clipEnd(prev) - cur.trackStart;
    if (overlap > allowedOverlap(project, track, prev) + 1e-6) {
      throw new Error(`Clip "${cur.id}" overlaps clip "${prev.id}" by ${overlap.toFixed(2)}s on track "${track.name}"`);
    }
  }
}

export function addClip(
  project: VideoProject,
  mediaAssets: Map<string, MediaAsset>,
  trackId: string,
  input: Omit<TimelineClip, 'id' | 'volume' | 'effect'> & Partial<Pick<TimelineClip, 'volume' | 'effect'>>
): TimelineClip {
  const track = getTrack(project, trackId);
  const media = mediaAssets.get(input.mediaId);
  if (!media) throw new Error(`Media asset not found: ${input.mediaId}`);
  if (track.kind === 'video' && !media.hasVideo) throw new Error('Cannot place audio-only media on a video track');
  if (track.kind === 'audio' && !media.hasAudio) throw new Error('Cannot place media without audio on an audio track');
  const clip: TimelineClip = {
    id: crypto.randomUUID(),
    volume: 1,
    effect: 'none',
    ...input
  };
  validateClipAgainstMedia(clip, media);
  assertNoOverlap(project, track, clip);
  track.clips.push(clip);
  track.clips.sort((a, b) => a.trackStart - b.trackStart);
  return clip;
}

/** Trim: adjust sourceIn/sourceOut and (optionally) move trackStart to keep the end fixed when trimming the head. */
export function trimClip(
  project: VideoProject,
  mediaAssets: Map<string, MediaAsset>,
  clipId: string,
  newIn: number,
  newOut: number,
  keepEndFixed: boolean = false
): TimelineClip {
  const { track, clip } = getClip(project, clipId);
  const media = mediaAssets.get(clip.mediaId);
  if (!media) throw new Error(`Media asset not found: ${clip.mediaId}`);
  const updated: TimelineClip = { ...clip, sourceIn: newIn, sourceOut: newOut };
  if (keepEndFixed) {
    updated.trackStart = clipEnd(clip) - clipDuration(updated);
  }
  validateClipAgainstMedia(updated, media);
  assertNoOverlap(project, track, updated, clipId);
  Object.assign(clip, updated);
  track.clips.sort((a, b) => a.trackStart - b.trackStart);
  return clip;
}

/** Split a clip at a timeline time; returns the new (right-hand) clip. */
export function splitClip(project: VideoProject, clipId: string, atTimelineSec: number): TimelineClip {
  const { track, clip } = getClip(project, clipId);
  if (atTimelineSec <= clip.trackStart || atTimelineSec >= clipEnd(clip)) {
    throw new Error(`Split point ${atTimelineSec}s is outside clip span ${clip.trackStart}s–${clipEnd(clip)}s`);
  }
  const offset = (atTimelineSec - clip.trackStart) * clipSpeed(clip); // timeline offset → source offset
  const right: TimelineClip = {
    ...clip,
    id: crypto.randomUUID(),
    trackStart: atTimelineSec,
    sourceIn: clip.sourceIn + offset
  };
  clip.sourceOut = clip.sourceIn + offset;
  track.clips.push(right);
  track.clips.sort((a, b) => a.trackStart - b.trackStart);
  return right;
}

export function moveClip(project: VideoProject, clipId: string, newTrackStart: number, targetTrackId?: string): TimelineClip {
  const { track, clip } = getClip(project, clipId);
  const target = targetTrackId ? getTrack(project, targetTrackId) : track;
  if (target.kind !== track.kind) throw new Error('Cannot move a clip between video and audio tracks');
  const moved: TimelineClip = { ...clip, trackStart: newTrackStart };
  if (newTrackStart < 0) throw new Error('trackStart cannot be negative');
  assertNoOverlap(project, target, moved, clipId);
  if (target.id !== track.id) {
    track.clips = track.clips.filter((c) => c.id !== clipId);
    target.clips.push(moved);
    target.clips.sort((a, b) => a.trackStart - b.trackStart);
    return moved;
  }
  clip.trackStart = newTrackStart;
  track.clips.sort((a, b) => a.trackStart - b.trackStart);
  return clip;
}

export function removeClip(project: VideoProject, clipId: string): void {
  const { track } = getClip(project, clipId);
  track.clips = track.clips.filter((c) => c.id !== clipId);
  project.transitions = project.transitions.filter((t) => t.afterClipId !== clipId);
}

export function setClipVolume(project: VideoProject, clipId: string, volume: number): void {
  if (volume < 0 || volume > 1) throw new Error('volume must be between 0 and 1');
  getClip(project, clipId).clip.volume = volume;
}

export function addTransition(
  project: VideoProject,
  afterClipId: string,
  durationSec: number,
  type: TransitionType = 'crossfade'
): void {
  validateTransitionType(type);
  const base = baseVideoTrack(project);
  const idx = base.clips.findIndex((c) => c.id === afterClipId);
  if (idx === -1) throw new Error('Transitions can only be added after a clip on the base video track');
  if (idx === base.clips.length - 1) throw new Error('Cannot add a transition after the last clip');
  if (durationSec <= 0) throw new Error('Transition duration must be positive');
  const outgoing = base.clips[idx];
  const incoming = base.clips[idx + 1];
  if (durationSec >= Math.min(clipDuration(outgoing), clipDuration(incoming))) {
    throw new Error('Transition must be shorter than both neighbouring clips');
  }
  project.transitions = project.transitions.filter((t) => t.afterClipId !== afterClipId);
  project.transitions.push({ afterClipId, type, durationSec });
}

/** Phase 28: remove the transition after a base clip (no-op-free: throws when absent). */
export function removeTransition(project: VideoProject, afterClipId: string): void {
  const before = project.transitions.length;
  project.transitions = project.transitions.filter((t) => t.afterClipId !== afterClipId);
  if (project.transitions.length === before) throw new Error(`No transition after clip ${afterClipId}`);
}

/** Total timeline duration accounting for crossfade overlaps on the base track. */
export function timelineDuration(project: VideoProject): number {
  let end = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) end = Math.max(end, clipEnd(clip));
  }
  for (const text of project.texts ?? []) end = Math.max(end, text.trackStart + text.durationSec);
  let transitionsTotal = 0;
  for (const t of project.transitions) transitionsTotal += t.durationSec;
  return Math.max(0, end - transitionsTotal);
}

export function validateProject(project: VideoProject, mediaAssets: Map<string, MediaAsset>): string[] {
  const errors: string[] = [];
  if (project.width <= 0 || project.height <= 0) errors.push('Project dimensions must be positive');
  if (project.fps <= 0) errors.push('Project fps must be positive');
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const media = mediaAssets.get(clip.mediaId);
      if (!media) {
        errors.push(`Clip ${clip.id} references missing media ${clip.mediaId}`);
        continue;
      }
      try {
        validateClipAgainstMedia(clip, media);
        // Phase 28: effect stack + keyframes validate with the clip.
        for (const instance of clip.effects ?? []) validateEffectInstance(instance);
        if (clip.keyframes?.length) {
          validateKeyframes(clip.keyframes, clipDuration(clip), { owner: `Clip ${clip.id}` });
        }
      } catch (e: any) {
        errors.push(`Clip ${clip.id}: ${e.message}`);
      }
    }
    try {
      const sorted = [...track.clips].sort((a, b) => a.trackStart - b.trackStart);
      for (let i = 1; i < sorted.length; i++) {
        const overlap = clipEnd(sorted[i - 1]) - sorted[i].trackStart;
        if (overlap > allowedOverlap(project, track, sorted[i - 1]) + 1e-6) {
          errors.push(`Track "${track.name}": clips ${sorted[i - 1].id} and ${sorted[i].id} overlap`);
        }
      }
    } catch (e: any) {
      errors.push(e.message);
    }
  }
  for (const text of project.texts ?? []) {
    if (!text.text || !text.text.trim()) errors.push(`Text element ${text.id}: text must not be empty`);
    if (text.trackStart < 0) errors.push(`Text element ${text.id}: trackStart cannot be negative`);
    if (text.durationSec <= 0) errors.push(`Text element ${text.id}: durationSec must be positive`);
    if (text.fontSize <= 0) errors.push(`Text element ${text.id}: fontSize must be positive`);
    if (!/^#[0-9A-Fa-f]{6}$/.test(text.color)) errors.push(`Text element ${text.id}: color must be #RRGGBB`);
    if (text.opacity !== undefined && (text.opacity < 0 || text.opacity > 1)) {
      errors.push(`Text element ${text.id}: opacity must be between 0 and 1`);
    }
    // Phase 28: text keyframes animate x/y only, within the element's span.
    if (text.keyframes?.length) {
      try {
        validateKeyframes(text.keyframes, text.durationSec, {
          owner: `Text element ${text.id}`,
          allowedProperties: ['x', 'y']
        });
      } catch (e: any) {
        errors.push(e.message);
      }
    }
  }
  for (const transition of project.transitions) {
    try {
      validateTransitionType(transition.type ?? 'crossfade');
    } catch (e: any) {
      errors.push(e.message);
    }
  }
  return errors;
}

// ------------------------------------------------------------ persistence

export function serializeVideoProject(project: VideoProject, mediaAssets: Map<string, MediaAsset>): SerializedVideoProject {
  return {
    format: 'squadforge-video-project',
    version: 1,
    project,
    media: [...mediaAssets.values()]
  };
}

export function deserializeVideoProject(data: SerializedVideoProject): { project: VideoProject; mediaAssets: Map<string, MediaAsset> } {
  if (!data || data.format !== 'squadforge-video-project' || data.version !== 1) {
    throw new Error('Not a SquadForge video project (bad format/version)');
  }
  const mediaAssets = new Map<string, MediaAsset>();
  for (const m of data.media || []) mediaAssets.set(m.id, m);
  if (!Array.isArray(data.project.texts)) data.project.texts = []; // Phase 20 files predate text layers
  const errors = validateProject(data.project, mediaAssets);
  if (errors.length > 0) throw new Error(`Invalid video project: ${errors.join('; ')}`);
  return { project: data.project, mediaAssets };
}

/**
 * Save with a recovery journal: the journal records the save state so
 * an interrupted export or crash never loses the project. Recovery =
 * load the last fully-written project file; a journal left in
 * 'exporting' state tells the caller an export died mid-flight while
 * the project itself is intact.
 */
export async function saveVideoProject(
  dir: string,
  project: VideoProject,
  mediaAssets: Map<string, MediaAsset>
): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, 'project.json.tmp');
  await fsp.writeFile(tmp, JSON.stringify(serializeVideoProject(project, mediaAssets), null, 2), 'utf-8');
  await fsp.rename(tmp, path.join(dir, 'project.json'));
  await fsp.writeFile(
    path.join(dir, 'journal.json'),
    JSON.stringify({ state: 'saved', at: new Date().toISOString(), projectId: project.id }, null, 2),
    'utf-8'
  );
}

export async function writeJournal(dir: string, state: string, detail?: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'journal.json'),
    JSON.stringify({ state, detail, at: new Date().toISOString() }, null, 2),
    'utf-8'
  );
}

export async function recoverVideoProject(
  dir: string
): Promise<{ project: VideoProject; mediaAssets: Map<string, MediaAsset>; journalState: string | null }> {
  const raw = await fsp.readFile(path.join(dir, 'project.json'), 'utf-8');
  const { project, mediaAssets } = deserializeVideoProject(JSON.parse(raw));
  let journalState: string | null = null;
  const journalPath = path.join(dir, 'journal.json');
  if (fs.existsSync(journalPath)) {
    try {
      journalState = JSON.parse(await fsp.readFile(journalPath, 'utf-8')).state ?? null;
    } catch {
      journalState = null;
    }
  }
  return { project, mediaAssets, journalState };
}
