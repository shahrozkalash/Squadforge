import * as crypto from 'crypto';
import type { CaptionCue, VideoProject } from './types.js';

/**
 * Phase 29: caption/subtitle track — real SRT and WebVTT import and
 * export, plus validated cue editing on the project. Timing is in
 * timeline seconds and is rendered by the same drawtext path in the
 * exporter and the preview renderer, so captions stay in sync with
 * the picture by construction.
 */

export function validateCue(cue: CaptionCue): void {
  if (!Number.isFinite(cue.startSec) || cue.startSec < 0) throw new Error('Caption startSec cannot be negative');
  if (!Number.isFinite(cue.endSec) || cue.endSec <= cue.startSec) throw new Error('Caption endSec must be after startSec');
  if (!cue.text || !cue.text.trim()) throw new Error('Caption text must not be empty');
}

export function sortCues(cues: CaptionCue[]): CaptionCue[] {
  return [...cues].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}

export function addCaption(project: VideoProject, input: Omit<CaptionCue, 'id'>): CaptionCue {
  const cue: CaptionCue = { ...input, id: crypto.randomUUID() };
  validateCue(cue);
  project.captions = sortCues([...(project.captions ?? []), cue]);
  return cue;
}

export function updateCaption(project: VideoProject, cueId: string, patch: Partial<Omit<CaptionCue, 'id'>>): CaptionCue {
  const cue = (project.captions ?? []).find((c) => c.id === cueId);
  if (!cue) throw new Error(`Caption cue not found: ${cueId}`);
  const next = { ...cue, ...patch };
  validateCue(next);
  Object.assign(cue, next);
  project.captions = sortCues(project.captions ?? []);
  return cue;
}

export function removeCaption(project: VideoProject, cueId: string): void {
  const before = (project.captions ?? []).length;
  project.captions = (project.captions ?? []).filter((c) => c.id !== cueId);
  if (project.captions.length === before) throw new Error(`Caption cue not found: ${cueId}`);
}

export function activeCaptionAt(project: VideoProject, timeSec: number): CaptionCue | null {
  for (const cue of project.captions ?? []) {
    if (timeSec >= cue.startSec && timeSec < cue.endSec) return cue;
  }
  return null;
}

// ---------------------------------------------------------------- time formats

function formatTimestamp(sec: number, separator: ',' | '.'): string {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const pad = (v: number, n: number): string => String(v).padStart(n, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${separator}${pad(ms, 3)}`;
}

function parseTimestamp(raw: string): number | null {
  const match = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

// ---------------------------------------------------------------- SRT

export function captionsToSrt(cues: CaptionCue[]): string {
  return (
    sortCues(cues)
      .map((cue, i) => `${i + 1}\n${formatTimestamp(cue.startSec, ',')} --> ${formatTimestamp(cue.endSec, ',')}\n${cue.text.trim()}\n`)
      .join('\n') + (cues.length > 0 ? '\n' : '')
  );
}

export function parseSrt(content: string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const blocks = content.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) throw new Error(`Malformed SRT block (no timing line): "${lines[0].slice(0, 40)}"`);
    const [startRaw, endRaw] = lines[timingIdx].split('-->').map((p) => p.trim().split(/\s+/)[0]);
    const startSec = parseTimestamp(startRaw);
    const endSec = parseTimestamp(endRaw);
    if (startSec === null || endSec === null) throw new Error(`Malformed SRT timing: "${lines[timingIdx]}"`);
    const text = lines.slice(timingIdx + 1).join('\n');
    const cue: CaptionCue = { id: crypto.randomUUID(), startSec, endSec, text };
    validateCue(cue);
    cues.push(cue);
  }
  return sortCues(cues);
}

// ---------------------------------------------------------------- WebVTT

export function captionsToVtt(cues: CaptionCue[]): string {
  const body = sortCues(cues)
    .map((cue) => `${formatTimestamp(cue.startSec, '.')} --> ${formatTimestamp(cue.endSec, '.')}\n${cue.text.trim()}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

export function parseVtt(content: string): CaptionCue[] {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.trimStart().startsWith('WEBVTT')) throw new Error('Not a WebVTT file (missing WEBVTT header)');
  const cues: CaptionCue[] = [];
  const blocks = normalized.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0 || lines[0] === 'WEBVTT' || lines[0].startsWith('NOTE')) continue;
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) continue; // metadata blocks are skipped, cues are not invented
    const [startRaw, endRaw] = lines[timingIdx].split('-->').map((p) => p.trim().split(/\s+/)[0]);
    const startSec = parseTimestamp(startRaw);
    const endSec = parseTimestamp(endRaw);
    if (startSec === null || endSec === null) throw new Error(`Malformed VTT timing: "${lines[timingIdx]}"`);
    const text = lines.slice(timingIdx + 1).join('\n').replace(/<[^>]+>/g, '');
    const cue: CaptionCue = { id: crypto.randomUUID(), startSec, endSec, text };
    validateCue(cue);
    cues.push(cue);
  }
  return sortCues(cues);
}

export function parseCaptions(content: string, format: 'srt' | 'vtt'): CaptionCue[] {
  return format === 'srt' ? parseSrt(content) : parseVtt(content);
}

export function formatCaptions(cues: CaptionCue[], format: 'srt' | 'vtt'): string {
  return format === 'srt' ? captionsToSrt(cues) : captionsToVtt(cues);
}
