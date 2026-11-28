import * as crypto from 'crypto';
import type { ClipTransform, MediaAsset, TextElement, TimelineClip, TimelineTrack, VideoProject } from './types.js';
import { DEFAULT_TRANSFORM } from './types.js';
import {
  addClip,
  addTrack,
  addTransition,
  assertNoOverlap,
  assertTrackUnlocked,
  clipDuration,
  clipEnd,
  clipSpeed,
  getClip,
  getTrack,
  moveClip,
  removeClip,
  removeTransition,
  setClipVolume,
  splitClip,
  trimClip,
  validateTransform
} from './timeline.js';
import { collectSnapPoints, snapMoveStart, snapTime, type SnapOptions } from './snapping.js';
import {
  sortedKeyframes,
  validateEffectInstance,
  validateKeyframes
} from './effects.js';
import type { CaptionCue, ClipEffectInstance, EffectType, Keyframe, TransitionType } from './types.js';
import { addCaption, removeCaption, updateCaption } from './captions.js';

/**
 * Phase 26: reusable, NON-DESTRUCTIVE editing operations.
 *
 * Every operation mutates only the project model (an edit decision
 * list). Source media files are never written, re-encoded, or moved
 * by any operation — rendering happens later, in the exporter, from
 * the original files. Each operation validates fully before applying,
 * so a rejected operation leaves the project untouched.
 */

export function cloneProject(project: VideoProject): VideoProject {
  return JSON.parse(JSON.stringify(project)) as VideoProject;
}

export function setClipTransform(
  project: VideoProject,
  mediaAssets: Map<string, MediaAsset>,
  clipId: string,
  patch: Partial<ClipTransform>
): TimelineClip {
  const { track, clip } = getClip(project, clipId);
  assertTrackUnlocked(track);
  const media = mediaAssets.get(clip.mediaId);
  const next: ClipTransform = { ...(clip.transform ?? DEFAULT_TRANSFORM), ...patch };
  if (patch.crop === undefined && clip.transform?.crop) next.crop = clip.transform.crop;
  validateTransform(next, media);
  clip.transform = next;
  return clip;
}

export function setClipSpeed(
  project: VideoProject,
  mediaAssets: Map<string, MediaAsset>,
  clipId: string,
  speed: number
): TimelineClip {
  if (speed < 0.25 || speed > 4) throw new Error('speed must be between 0.25 and 4');
  const { track, clip } = getClip(project, clipId);
  assertTrackUnlocked(track);
  const media = mediaAssets.get(clip.mediaId);
  if (!media) throw new Error(`Media asset not found: ${clip.mediaId}`);
  const updated: TimelineClip = { ...clip, speed };
  // Duration changes with speed — the new span must still fit the track.
  assertNoOverlap(project, track, updated, clipId);
  clip.speed = speed;
  return clip;
}

/** Duplicate a clip immediately after the original (same track), if the space is free. */
export function duplicateClip(project: VideoProject, clipId: string): TimelineClip {
  const { track, clip } = getClip(project, clipId);
  assertTrackUnlocked(track);
  const copy: TimelineClip = {
    ...clip,
    id: crypto.randomUUID(),
    trackStart: clipEnd(clip),
    transform: clip.transform ? JSON.parse(JSON.stringify(clip.transform)) : undefined
  };
  assertNoOverlap(project, track, copy);
  track.clips.push(copy);
  track.clips.sort((a, b) => a.trackStart - b.trackStart);
  return copy;
}

export function addTextElement(project: VideoProject, input: Omit<TextElement, 'id'>): TextElement {
  const element: TextElement = { ...input, id: crypto.randomUUID() };
  if (!element.text.trim()) throw new Error('text must not be empty');
  if (element.trackStart < 0) throw new Error('trackStart cannot be negative');
  if (element.durationSec <= 0) throw new Error('durationSec must be positive');
  if (element.fontSize <= 0) throw new Error('fontSize must be positive');
  if (!/^#[0-9A-Fa-f]{6}$/.test(element.color)) throw new Error('color must be #RRGGBB');
  if (element.opacity !== undefined && (element.opacity < 0 || element.opacity > 1)) {
    throw new Error('opacity must be between 0 and 1');
  }
  (project.texts ??= []).push(element);
  return element;
}

export function updateTextElement(project: VideoProject, textId: string, patch: Partial<Omit<TextElement, 'id'>>): TextElement {
  const element = (project.texts ?? []).find((t) => t.id === textId);
  if (!element) throw new Error(`Text element not found: ${textId}`);
  const next = { ...element, ...patch };
  if (!next.text.trim()) throw new Error('text must not be empty');
  if (next.trackStart < 0) throw new Error('trackStart cannot be negative');
  if (next.durationSec <= 0) throw new Error('durationSec must be positive');
  if (next.fontSize <= 0) throw new Error('fontSize must be positive');
  if (!/^#[0-9A-Fa-f]{6}$/.test(next.color)) throw new Error('color must be #RRGGBB');
  Object.assign(element, next);
  return element;
}

export function removeTextElement(project: VideoProject, textId: string): void {
  const before = (project.texts ?? []).length;
  project.texts = (project.texts ?? []).filter((t) => t.id !== textId);
  if (project.texts.length === before) throw new Error(`Text element not found: ${textId}`);
}

/** Reorder the text layer stack (later = on top). */
export function moveTextElement(project: VideoProject, textId: string, toIndex: number): void {
  const texts = project.texts ?? [];
  const from = texts.findIndex((t) => t.id === textId);
  if (from === -1) throw new Error(`Text element not found: ${textId}`);
  if (toIndex < 0 || toIndex >= texts.length) throw new Error(`toIndex ${toIndex} out of range`);
  const [el] = texts.splice(from, 1);
  texts.splice(toIndex, 0, el);
}

// ---------------------------------------------------------------- Phase 28 ops

export function addEffect(project: VideoProject, clipId: string, effectType: EffectType, value: number): ClipEffectInstance {
  const { track, clip } = getClip(project, clipId);
  assertTrackUnlocked(track);
  const instance: ClipEffectInstance = { id: crypto.randomUUID(), type: effectType, value };
  validateEffectInstance(instance);
  (clip.effects ??= []).push(instance);
  return instance;
}

export function updateEffect(project: VideoProject, clipId: string, effectId: string, value: number): ClipEffectInstance {
  const { track, clip } = getClip(project, clipId);
  assertTrackUnlocked(track);
  const instance = (clip.effects ?? []).find((e) => e.id === effectId);
  if (!instance) throw new Error(`Effect instance not found: ${effectId}`);
  validateEffectInstance({ ...instance, value });
  instance.value = value;
  return instance;
}

export function removeEffect(project: VideoProject, clipId: string, effectId: string): void {
  const { track, clip } = getClip(project, clipId);
  assertTrackUnlocked(track);
  const before = (clip.effects ?? []).length;
  clip.effects = (clip.effects ?? []).filter((e) => e.id !== effectId);
  if (clip.effects.length === before) throw new Error(`Effect instance not found: ${effectId}`);
}

export function moveEffect(project: VideoProject, clipId: string, effectId: string, toIndex: number): void {
  const { track, clip } = getClip(project, clipId);
  assertTrackUnlocked(track);
  const effects = clip.effects ?? [];
  const from = effects.findIndex((e) => e.id === effectId);
  if (from === -1) throw new Error(`Effect instance not found: ${effectId}`);
  if (toIndex < 0 || toIndex >= effects.length) throw new Error(`toIndex ${toIndex} out of range`);
  const [instance] = effects.splice(from, 1);
  effects.splice(toIndex, 0, instance);
}

/** Replace a clip's keyframe track (validated against the clip's duration). */
export function setClipKeyframes(project: VideoProject, clipId: string, keyframes: Keyframe[]): TimelineClip {
  const { track, clip } = getClip(project, clipId);
  assertTrackUnlocked(track);
  validateKeyframes(keyframes, clipDuration(clip), { owner: `Clip ${clipId}` });
  clip.keyframes = sortedKeyframes(keyframes).map((kf) => ({ ...kf, id: kf.id || crypto.randomUUID() }));
  return clip;
}

/** Replace a text element's position keyframes (x/y only). */
export function setTextKeyframes(project: VideoProject, textId: string, keyframes: Keyframe[]): TextElement {
  const element = (project.texts ?? []).find((t) => t.id === textId);
  if (!element) throw new Error(`Text element not found: ${textId}`);
  validateKeyframes(keyframes, element.durationSec, { owner: `Text element ${textId}`, allowedProperties: ['x', 'y'] });
  element.keyframes = sortedKeyframes(keyframes).map((kf) => ({ ...kf, id: kf.id || crypto.randomUUID() }));
  return element;
}

// ---------------------------------------------------------------- Phase 29 ops

export function setClipFades(project: VideoProject, clipId: string, fadeInSec: number, fadeOutSec: number): TimelineClip {
  const { track, clip } = getClip(project, clipId);
  assertTrackUnlocked(track);
  if (fadeInSec < 0 || fadeOutSec < 0) throw new Error('audio fades cannot be negative');
  if (fadeInSec + fadeOutSec > clipDuration(clip) + 1e-6) {
    throw new Error(`audio fades (${fadeInSec}s + ${fadeOutSec}s) exceed the clip duration (${clipDuration(clip)}s)`);
  }
  clip.fadeInSec = fadeInSec;
  clip.fadeOutSec = fadeOutSec;
  return clip;
}

export function setTrackVolume(project: VideoProject, trackId: string, volume: number): void {
  if (volume < 0 || volume > 2) throw new Error('track volume must be between 0 and 2');
  getTrack(project, trackId).volume = volume;
}

export function setTrackMuted(project: VideoProject, trackId: string, muted: boolean): void {
  getTrack(project, trackId).muted = muted;
}

/**
 * Phase 2 (Video Editor Roadmap): lock/unlock a track. This is a
 * track control, so it is deliberately NOT blocked by the lock
 * itself — a locked track must always be unlockable. While locked,
 * every clip-level edit on the track throws (see assertTrackUnlocked
 * in timeline.ts).
 */
export function setTrackLocked(project: VideoProject, trackId: string, locked: boolean): void {
  getTrack(project, trackId).locked = locked;
}

export type EditOperation =
  | { type: 'addTrack'; kind: 'video' | 'audio'; name?: string }
  | { type: 'addClip'; trackId: string; clip: Parameters<typeof addClip>[3] }
  | { type: 'trim'; clipId: string; sourceIn: number; sourceOut: number; keepEndFixed?: boolean; snap?: boolean | SnapOptions }
  | { type: 'split'; clipId: string; atTimelineSec: number }
  | { type: 'move'; clipId: string; trackStart: number; targetTrackId?: string; snap?: boolean | SnapOptions }
  | { type: 'remove'; clipId: string }
  | { type: 'duplicate'; clipId: string }
  | { type: 'setVolume'; clipId: string; volume: number }
  | { type: 'setTransform'; clipId: string; transform: Partial<ClipTransform> }
  | { type: 'setSpeed'; clipId: string; speed: number }
  | { type: 'addText'; text: Omit<TextElement, 'id'> }
  | { type: 'updateText'; textId: string; patch: Partial<Omit<TextElement, 'id'>> }
  | { type: 'removeText'; textId: string }
  | { type: 'moveText'; textId: string; toIndex: number }
  | { type: 'addEffect'; clipId: string; effectType: EffectType; value: number }
  | { type: 'updateEffect'; clipId: string; effectId: string; value: number }
  | { type: 'removeEffect'; clipId: string; effectId: string }
  | { type: 'moveEffect'; clipId: string; effectId: string; toIndex: number }
  | { type: 'setKeyframes'; clipId: string; keyframes: Keyframe[] }
  | { type: 'setTextKeyframes'; textId: string; keyframes: Keyframe[] }
  | { type: 'addTransition'; afterClipId: string; durationSec: number; transitionType?: TransitionType }
  | { type: 'removeTransition'; afterClipId: string }
  | { type: 'setFades'; clipId: string; fadeInSec: number; fadeOutSec: number }
  | { type: 'setTrackVolume'; trackId: string; volume: number }
  | { type: 'setTrackMuted'; trackId: string; muted: boolean }
  | { type: 'setTrackLocked'; trackId: string; locked: boolean }
  | { type: 'addCaption'; caption: Omit<CaptionCue, 'id'> }
  | { type: 'updateCaption'; cueId: string; patch: Partial<Omit<CaptionCue, 'id'>> }
  | { type: 'removeCaption'; cueId: string };

/** The single entry point the routes/UI use — one validated operation at a time. */
export function applyEditOperation(
  project: VideoProject,
  mediaAssets: Map<string, MediaAsset>,
  op: EditOperation
): { clip?: TimelineClip; text?: TextElement; caption?: CaptionCue; track?: TimelineTrack } {
  switch (op.type) {
    case 'addTrack': {
      if (op.kind !== 'video' && op.kind !== 'audio') throw new Error(`Track kind must be 'video' or 'audio', got '${op.kind}'`);
      return { track: addTrack(project, op.kind, op.name) };
    }
    case 'addClip':
      return { clip: addClip(project, mediaAssets, op.trackId, op.clip) };
    case 'trim': {
      // Phase 2: optional snapping of the moving timeline edge. A
      // plain trim moves the END edge; keepEndFixed moves the START
      // edge. The snapped edge time is converted back to source
      // values (source delta = timeline delta × speed); trimClip
      // then validates the result exactly as for an unsnapped trim.
      let { sourceIn, sourceOut } = op;
      if (op.snap) {
        const snapOptions = op.snap === true ? {} : op.snap;
        const { clip } = getClip(project, op.clipId);
        const speed = clipSpeed(clip);
        const points = collectSnapPoints(project, { ...snapOptions, excludeClipId: clip.id });
        if (op.keepEndFixed) {
          const end = clipEnd(clip);
          const desiredStart = end - (sourceOut - sourceIn) / speed;
          const snapped = snapTime(desiredStart, points, snapOptions);
          if (snapped.snapped) sourceIn = sourceOut - (end - snapped.time) * speed;
        } else {
          const desiredEnd = clip.trackStart + (sourceOut - sourceIn) / speed;
          const snapped = snapTime(desiredEnd, points, snapOptions);
          if (snapped.snapped) sourceOut = sourceIn + (snapped.time - clip.trackStart) * speed;
        }
      }
      return { clip: trimClip(project, mediaAssets, op.clipId, sourceIn, sourceOut, op.keepEndFixed) };
    }
    case 'split':
      return { clip: splitClip(project, op.clipId, op.atTimelineSec) };
    case 'move': {
      // Phase 2: optional snapping (start or end edge, whichever is
      // closer to a snap point). Without `snap`, the requested
      // trackStart is used verbatim — behaviour unchanged.
      let trackStart = op.trackStart;
      if (op.snap) {
        const snapOptions = op.snap === true ? {} : op.snap;
        const { clip } = getClip(project, op.clipId);
        const points = collectSnapPoints(project, { ...snapOptions, excludeClipId: clip.id });
        trackStart = snapMoveStart(clip, trackStart, points, snapOptions).time;
      }
      return { clip: moveClip(project, op.clipId, trackStart, op.targetTrackId) };
    }
    case 'remove':
      removeClip(project, op.clipId);
      return {};
    case 'duplicate':
      return { clip: duplicateClip(project, op.clipId) };
    case 'setVolume':
      setClipVolume(project, op.clipId, op.volume);
      return { clip: getClip(project, op.clipId).clip };
    case 'setTransform':
      return { clip: setClipTransform(project, mediaAssets, op.clipId, op.transform) };
    case 'setSpeed':
      return { clip: setClipSpeed(project, mediaAssets, op.clipId, op.speed) };
    case 'addText':
      return { text: addTextElement(project, op.text) };
    case 'updateText':
      return { text: updateTextElement(project, op.textId, op.patch) };
    case 'removeText':
      removeTextElement(project, op.textId);
      return {};
    case 'moveText':
      moveTextElement(project, op.textId, op.toIndex);
      return { text: (project.texts ?? []).find((t) => t.id === op.textId) };
    case 'addEffect':
      addEffect(project, op.clipId, op.effectType, op.value);
      return { clip: getClip(project, op.clipId).clip };
    case 'updateEffect':
      updateEffect(project, op.clipId, op.effectId, op.value);
      return { clip: getClip(project, op.clipId).clip };
    case 'removeEffect':
      removeEffect(project, op.clipId, op.effectId);
      return { clip: getClip(project, op.clipId).clip };
    case 'moveEffect':
      moveEffect(project, op.clipId, op.effectId, op.toIndex);
      return { clip: getClip(project, op.clipId).clip };
    case 'setKeyframes':
      return { clip: setClipKeyframes(project, op.clipId, op.keyframes) };
    case 'setTextKeyframes':
      return { text: setTextKeyframes(project, op.textId, op.keyframes) };
    case 'addTransition':
      addTransition(project, op.afterClipId, op.durationSec, op.transitionType ?? 'crossfade');
      return {};
    case 'removeTransition':
      removeTransition(project, op.afterClipId);
      return {};
    case 'setFades':
      return { clip: setClipFades(project, op.clipId, op.fadeInSec, op.fadeOutSec) };
    case 'setTrackVolume':
      setTrackVolume(project, op.trackId, op.volume);
      return {};
    case 'setTrackMuted':
      setTrackMuted(project, op.trackId, op.muted);
      return {};
    case 'setTrackLocked':
      setTrackLocked(project, op.trackId, op.locked);
      return {};
    case 'addCaption':
      return { caption: addCaption(project, op.caption) };
    case 'updateCaption':
      return { caption: updateCaption(project, op.cueId, op.patch) };
    case 'removeCaption':
      removeCaption(project, op.cueId);
      return {};
    default:
      throw new Error(`Unknown edit operation: ${(op as any).type}`);
  }
}

export { clipDuration, clipEnd, getTrack };
