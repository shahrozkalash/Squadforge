import type { MediaAsset, VideoProject } from './types.js';
import { applyEditOperation, cloneProject, type EditOperation } from './editingOps.js';
import { recoverVideoProject, saveVideoProject } from './timeline.js';

/**
 * Video Editor Roadmap Phase 1: editor history + session state.
 *
 * Undo/redo for the video editor, built on the model layer — the
 * same snapshot approach the image editor's HistoryStack proved
 * (server/imageEditor/imageCore.ts), adapted to this model:
 * snapshots are deep clones of the VideoProject taken through the
 * existing cloneProject(), and undo/redo restore IN PLACE, because
 * every editing operation in timeline.ts/editingOps.ts mutates the
 * project object it is handed. Restoring in place keeps the caller's
 * reference valid — a session, a test, or any future route holding
 * the project sees the restored state without re-binding.
 *
 * Snapshots are project JSON (no media bytes — assets are referenced
 * by id), so the memory cost of one snapshot is the size of the
 * project document; the stack is bounded and the bound is explicit.
 */

/** Replace the contents of `target` with a deep clone of `source`, in place. */
export function restoreProjectInto(target: VideoProject, source: VideoProject): void {
  const fresh = cloneProject(source);
  for (const key of Object.keys(target)) {
    delete (target as unknown as Record<string, unknown>)[key];
  }
  Object.assign(target, fresh);
}

export class EditHistory {
  private undoStack: VideoProject[] = [];
  private redoStack: VideoProject[] = [];

  constructor(private readonly limit: number = 50) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('EditHistory limit must be a positive integer');
    }
  }

  get historyLimit(): number {
    return this.limit;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  /**
   * Checkpoint the project's CURRENT state as the newest undo point
   * (call BEFORE applying an edit, the image-editor convention).
   * Any new edit invalidates the redo stack.
   */
  commit(project: VideoProject): void {
    this.commitSnapshot(cloneProject(project));
  }

  /**
   * Checkpoint a snapshot the caller already cloned (ownership
   * transfers to the history). Used by the transactional wrapper
   * below, which needs the same clone for rollback on failure.
   */
  commitSnapshot(snapshot: VideoProject): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Restore the most recent checkpoint into `project`, in place. */
  undo(project: VideoProject): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(cloneProject(project));
    restoreProjectInto(project, prev);
    return true;
  }

  /** Re-apply the most recently undone checkpoint, in place. */
  redo(project: VideoProject): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(cloneProject(project));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    restoreProjectInto(project, next);
    return true;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/**
 * applyEditOperation with history — the single integration point
 * between the Phase 26 operation dispatcher and undo/redo.
 *
 * Transactional: the pre-edit snapshot is taken first; if the
 * operation throws, the project is restored from that snapshot (a
 * rejected operation leaves the project AND the history untouched)
 * and the error propagates. On success the snapshot becomes the
 * newest undo point.
 */
export function applyEditOperationWithHistory(
  project: VideoProject,
  mediaAssets: Map<string, MediaAsset>,
  op: EditOperation,
  history: EditHistory
): ReturnType<typeof applyEditOperation> {
  const before = cloneProject(project);
  try {
    const result = applyEditOperation(project, mediaAssets, op);
    history.commitSnapshot(before);
    return result;
  } catch (err) {
    restoreProjectInto(project, before);
    throw err;
  }
}

/**
 * A server-side editing session: the owning object for one project's
 * editor state — the project model, its media assets, its undo/redo
 * history, and (optionally) debounced autosave to the project's
 * on-disk home, using the same atomic save + journal as the routes
 * (timeline.ts saveVideoProject). PlaybackSession (playback.ts) is
 * the precedent for a stateful server-side holder of project+media;
 * this is its editing counterpart.
 *
 * The HTTP routes stay stateless (Phase 31 contract: the client
 * submits the project per call); the session is the model-layer
 * state owner for embedders that keep a project open server-side.
 */
export class EditorSession {
  readonly history: EditHistory;
  private dirty_ = false;
  private saveDir: string | null = null;
  private debounceMs = 900;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSaveError_: string | undefined;
  private lastSavedAt_: string | undefined;

  constructor(
    readonly project: VideoProject,
    readonly mediaAssets: Map<string, MediaAsset> = new Map(),
    historyLimit: number = 50
  ) {
    this.history = new EditHistory(historyLimit);
  }

  /** Recover a session from a saved project directory (journal-aware). */
  static async load(dir: string, historyLimit: number = 50): Promise<{ session: EditorSession; journalState: string | null }> {
    const { project, mediaAssets, journalState } = await recoverVideoProject(dir);
    const session = new EditorSession(project, mediaAssets, historyLimit);
    return { session, journalState };
  }

  get dirty(): boolean {
    return this.dirty_;
  }

  get lastSaveError(): string | undefined {
    return this.lastSaveError_;
  }

  get lastSavedAt(): string | undefined {
    return this.lastSavedAt_;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  registerMedia(asset: MediaAsset): void {
    this.mediaAssets.set(asset.id, asset);
  }

  /** Apply one validated edit operation, recorded for undo. */
  apply(op: EditOperation): ReturnType<typeof applyEditOperation> {
    const result = applyEditOperationWithHistory(this.project, this.mediaAssets, op, this.history);
    this.markDirty();
    return result;
  }

  undo(): boolean {
    const done = this.history.undo(this.project);
    if (done) this.markDirty();
    return done;
  }

  redo(): boolean {
    const done = this.history.redo(this.project);
    if (done) this.markDirty();
    return done;
  }

  /**
   * Autosave edits (and undo/redo) to `dir` through saveVideoProject,
   * debounced like the web editor's 900 ms autosave. Save failures
   * are captured in lastSaveError, never thrown into the edit path.
   */
  enableAutosave(dir: string, debounceMs: number = 900): void {
    if (!(debounceMs >= 0)) throw new Error('autosave debounce must be >= 0');
    this.saveDir = dir;
    this.debounceMs = debounceMs;
  }

  disableAutosave(): void {
    this.saveDir = null;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /** Write the project now (cancels any pending debounced save). */
  async saveNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.saveDir) throw new Error('Autosave is not enabled for this session (no save directory)');
    await saveVideoProject(this.saveDir, this.project, this.mediaAssets);
    this.dirty_ = false;
    this.lastSaveError_ = undefined;
    this.lastSavedAt_ = new Date().toISOString();
  }

  /** Stop timers. Unsaved changes are NOT flushed implicitly — call saveNow() first if they matter. */
  close(): void {
    this.disableAutosave();
  }

  private markDirty(): void {
    this.dirty_ = true;
    if (!this.saveDir) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow().catch((err: any) => {
        this.lastSaveError_ = err?.message || String(err);
      });
    }, this.debounceMs);
    // A pending autosave must never keep a process alive on its own.
    (this.saveTimer as unknown as { unref?: () => void }).unref?.();
  }
}
