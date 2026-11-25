import * as crypto from 'crypto';
import type { ClipTransform, MediaAsset, TextElement, TimelineClip, VideoProject } from './types.js';
import { DEFAULT_TRANSFORM } from './types.js';
import {
  addClip,
  assertNoOverlap,
  clipDuration,
  clipEnd,
  getClip,
  getTrack,
  moveClip,
  removeClip,
  setClipVolume,
  splitClip,
  trimClip,
  validateTransform
} from './timeline.js';

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
  const { clip } = getClip(project, clipId);
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

export type EditOperation =
  | { type: 'addClip'; trackId: string; clip: Parameters<typeof addClip>[3] }
  | { type: 'trim'; clipId: string; sourceIn: number; sourceOut: number; keepEndFixed?: boolean }
  | { type: 'split'; clipId: string; atTimelineSec: number }
  | { type: 'move'; clipId: string; trackStart: number; targetTrackId?: string }
  | { type: 'remove'; clipId: string }
  | { type: 'duplicate'; clipId: string }
  | { type: 'setVolume'; clipId: string; volume: number }
  | { type: 'setTransform'; clipId: string; transform: Partial<ClipTransform> }
  | { type: 'setSpeed'; clipId: string; speed: number }
  | { type: 'addText'; text: Omit<TextElement, 'id'> }
  | { type: 'updateText'; textId: string; patch: Partial<Omit<TextElement, 'id'>> }
  | { type: 'removeText'; textId: string }
  | { type: 'moveText'; textId: string; toIndex: number };

/** The single entry point the routes/UI use — one validated operation at a time. */
export function applyEditOperation(
  project: VideoProject,
  mediaAssets: Map<string, MediaAsset>,
  op: EditOperation
): { clip?: TimelineClip; text?: TextElement } {
  switch (op.type) {
    case 'addClip':
      return { clip: addClip(project, mediaAssets, op.trackId, op.clip) };
    case 'trim':
      return { clip: trimClip(project, mediaAssets, op.clipId, op.sourceIn, op.sourceOut, op.keepEndFixed) };
    case 'split':
      return { clip: splitClip(project, op.clipId, op.atTimelineSec) };
    case 'move':
      return { clip: moveClip(project, op.clipId, op.trackStart, op.targetTrackId) };
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
    default:
      throw new Error(`Unknown edit operation: ${(op as any).type}`);
  }
}

export { clipDuration, clipEnd, getTrack };
