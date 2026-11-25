/**
 * Phase 33: structured audit log for security-relevant actions.
 *
 * Records WHO did WHAT to WHICH build and how it ended — approval
 * decisions, deployments, execution sessions, repair rollbacks,
 * GitHub connections — as JSON events, in an in-memory ring (for
 * tests and inspection) and optionally appended to `AUDIT_LOG_PATH`.
 *
 * Secrets are structurally excluded: any field whose key looks like a
 * token/secret/password/key/cookie is replaced with '[REDACTED]', and
 * common credential value shapes (Bearer headers, sk-, ghp_, AIza,
 * xox…) are redacted wherever they appear. Callers must still pass
 * only ids and outcomes, never prompts, file contents or credentials.
 * Logging never throws: an audit failure must not break the operation
 * it describes.
 */
import fs from 'fs';

export interface AuditEvent {
  ts: string;
  action: string;
  actorId?: string;
  buildId?: string;
  outcome?: string;
  details?: Record<string, unknown>;
}

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential|private[-_]?key)/i;
const SECRET_VALUE = /^(Bearer\s|sk-|ghp_|gho_|ghu_|AIza|xox[baprs]-)/;

export function redactAuditValue(key: string, value: unknown, depth = 0): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) return '[REDACTED]';
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (Array.isArray(value)) {
    return depth >= 4 ? '[…]' : value.map((v) => redactAuditValue('', v, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth >= 4) return '[…]';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactAuditValue(k, v, depth + 1);
    }
    return out;
  }
  return value;
}

const memory: AuditEvent[] = [];
const MAX_MEMORY = 1000;

export function recentAuditEvents(limit = 100): AuditEvent[] {
  return memory.slice(-Math.max(0, limit));
}

export function clearAuditEventsForTests(): void {
  memory.length = 0;
}

export function auditLog(
  action: string,
  fields: { actorId?: string; buildId?: string; outcome?: string; details?: Record<string, unknown> } = {}
): AuditEvent {
  const event: AuditEvent = {
    ts: new Date().toISOString(),
    action,
    ...(fields.actorId ? { actorId: fields.actorId } : {}),
    ...(fields.buildId ? { buildId: fields.buildId } : {}),
    ...(fields.outcome ? { outcome: fields.outcome } : {}),
    ...(fields.details
      ? { details: redactAuditValue('', fields.details) as Record<string, unknown> }
      : {})
  };
  memory.push(event);
  if (memory.length > MAX_MEMORY) memory.splice(0, memory.length - MAX_MEMORY);
  const path = process.env.AUDIT_LOG_PATH;
  if (path) {
    try {
      fs.appendFileSync(path, `${JSON.stringify(event)}\n`);
    } catch {
      // Never break the audited operation because the log failed.
    }
  }
  return event;
}
