import type { TimelineClip, VideoProject } from './types.js';
import { clipDuration, clipEnd, timelineDuration } from './timeline.js';

/**
 * Phase 2 (Video Editor Roadmap): edit snapping.
 *
 * Magnetic snapping for timeline edits: when a clip is moved or an
 * edge is trimmed, the moving edge is pulled to the nearest snap
 * point when it comes within a threshold. Snap points are the
 * timeline origin, the project end, every other clip's start/end on
 * every track (clip edges and track boundaries), and — when the
 * caller supplies it — the playhead.
 *
 * These are pure functions over the project model. The dispatcher in
 * editingOps.ts applies them to `move`/`trim` operations that carry
 * a `snap` option; the view layer can use the same functions during
 * drags. Without a `snap` option, operations behave exactly as
 * before — snapping is always opt-in per operation.
 *
 * Note the distinction from playback.ts `frameSnap`, which quantizes
 * a *seek position* to the frame grid; that is not edit snapping.
 */

/** Default magnet strength: an edge within 0.25 s of a point snaps to it. */
export const DEFAULT_SNAP_THRESHOLD_SEC = 0.25;

export interface SnapOptions {
  /** Max distance (seconds) at which an edge snaps. Default DEFAULT_SNAP_THRESHOLD_SEC. */
  thresholdSec?: number;
  /** Playhead position (seconds) — included as a snap point when given. */
  playheadSec?: number;
}

export interface SnapResult {
  /** The (possibly adjusted) time. */
  time: number;
  /** True when the time was pulled to a snap point. */
  snapped: boolean;
  /** The snap point that captured the edge, or null when unsnapped. */
  target: number | null;
}

function resolveThreshold(options?: SnapOptions): number {
  const threshold = options?.thresholdSec ?? DEFAULT_SNAP_THRESHOLD_SEC;
  if (!(threshold >= 0)) throw new Error('snap thresholdSec cannot be negative');
  return threshold;
}

/**
 * All snap points of a project, sorted ascending and deduplicated:
 * 0, the timeline end, and the start/end of every clip on every
 * track. `excludeClipId` omits the clip being edited (its own edges
 * must never capture it).
 */
export function collectSnapPoints(
  project: VideoProject,
  options?: SnapOptions & { excludeClipId?: string }
): number[] {
  const points = new Set<number>([0, timelineDuration(project)]);
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (options?.excludeClipId && clip.id === options.excludeClipId) continue;
      points.add(clip.trackStart);
      points.add(clipEnd(clip));
    }
  }
  if (options?.playheadSec !== undefined) {
    if (!(options.playheadSec >= 0)) throw new Error('snap playheadSec cannot be negative');
    points.add(options.playheadSec);
  }
  return [...points].sort((a, b) => a - b);
}

/** Snap one time to the nearest point within the threshold (inclusive). */
export function snapTime(timeSec: number, points: number[], options?: SnapOptions): SnapResult {
  const threshold = resolveThreshold(options);
  let best: number | null = null;
  let bestDelta = Infinity;
  for (const point of points) {
    const delta = Math.abs(point - timeSec);
    if (delta <= threshold && delta < bestDelta) {
      best = point;
      bestDelta = delta;
    }
  }
  if (best === null) return { time: timeSec, snapped: false, target: null };
  return { time: best, snapped: true, target: best };
}

export interface MoveSnapResult extends SnapResult {
  /** Which edge of the moving clip captured the snap point. */
  edge: 'start' | 'end' | null;
}

/**
 * Snap a clip move: both the clip's start edge and its end edge are
 * candidates; the edge with the smaller adjustment wins (ties prefer
 * the start edge). Returns the adjusted trackStart.
 */
export function snapMoveStart(
  clip: TimelineClip,
  desiredStart: number,
  points: number[],
  options?: SnapOptions
): MoveSnapResult {
  const duration = clipDuration(clip);
  const startSnap = snapTime(desiredStart, points, options);
  const endSnap = snapTime(desiredStart + duration, points, options);
  const startAdj = startSnap.snapped ? Math.abs(startSnap.time - desiredStart) : Infinity;
  const endAdj = endSnap.snapped ? Math.abs(endSnap.time - (desiredStart + duration)) : Infinity;
  if (startAdj === Infinity && endAdj === Infinity) {
    return { time: desiredStart, snapped: false, target: null, edge: null };
  }
  if (startAdj <= endAdj) {
    return { time: startSnap.time, snapped: true, target: startSnap.target, edge: 'start' };
  }
  return { time: endSnap.time - duration, snapped: true, target: endSnap.target, edge: 'end' };
}
