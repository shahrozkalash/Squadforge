import crypto from 'node:crypto';
import { db } from '../store.js';
import { ExecutionAdapter } from './executionAdapter.js';
import { 
  HumanApprovalRequest, 
  ApprovalOperationType, 
  ApprovalStatus, 
  AgentRole 
} from '../types.js';

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000; // 24-hour validity limit

const KNOWN_AGENT_ROLES = [
  'project_manager', 'software_architect', 'frontend_developer', 'backend_developer',
  'database_specialist', 'database_engineer', 'integration_specialist', 'integration_engineer',
  'qa_testing_specialist', 'qa_engineer', 'debugging_specialist', 'security_specialist',
  'devops_release_specialist', 'fullstack_developer', 'ui_ux_designer', 'performance_engineer',
  'documentation_engineer'
];

const SENSITIVE_WORDS = new Set([
  'auth', 'oauth', 'authn', 'authz', 'authentication', 'authorization',
  'crypto', 'secret', 'secrets', 'password', 'passwords', 'credential', 'credentials',
  'token', 'tokens', 'session', 'sessions', 'security', 'permission', 'permissions'
]);

export class ApprovalGateService {
  /**
   * Determines if a given operation requires human approval gate
   */
  static requiresApproval(operationType: ApprovalOperationType, affectedFilesCount: number): boolean {
    switch (operationType) {
      case 'destructive_file_op':
      case 'database_migration':
      case 'major_architecture_change':
      case 'security_sensitive_change':
      case 'project_rollback':
      case 'github_sensitive_commit':
        return true;
      case 'multi_file_wide_modification':
        return affectedFilesCount > 5;
      case 'large_dependency_change':
      case 'code_execution':
      case 'dependency_install':
      case 'install_scripts':
        return true;
      default:
        return false;
    }
  }

  /**
   * Identifies whether a file path touches sensitive security, auth, crypto, or environment files.
   */
  static isSensitiveFilePath(filePath: string): boolean {
    const normalized = filePath.toLowerCase().replace(/\\/g, '/');
    const sensitivePatterns = [
      /(?:^|\/)\.env(?:\..+)?$/,
      /(?:^|\/)package\.json$/,
      /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/,
      /(?:^|\/)\.(?:npmrc|yarnrc|yarnrc\.yml)$/,
      /(?:^|\/)dockerfile(?:\..+)?$/,
      /(?:^|\/)(?:docker-)?compose[^/]*\.ya?ml$/,
      /(?:^|\/)\.github\/workflows\//,
      /(?:^|\/)server\/(?:crypto|email|db\/database|gateway)\.ts$/,
      /\.(?:pem|key|p12|pfx)$/,
      /(?:^|\/)migrations\//
    ];
    if (sensitivePatterns.some(pattern => pattern.test(normalized))) return true;

    // Design tokens and docs about auth are not credentials
    if (/\.(?:css|scss|less|svg|png|jpe?g|gif|md|mdx)$/.test(normalized)) return false;

    // Split authMiddleware, AUTHService, auth_guard, and tokens.ts into words before matching
    const words = filePath
      .replace(/\\/g, '/')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/);
    return words.some(word => SENSITIVE_WORDS.has(word));
  }

  static isSensitiveFile(filePath: string): boolean {
    return this.isSensitiveFilePath(filePath);
  }

  /**
   * Determines if any files in a collection require security-sensitive human approval gate.
   */
  static isSensitiveOperation(filePaths: string[]): boolean {
    return filePaths.some(p => this.isSensitiveFilePath(p));
  }

  /** The path a write will really use, so checks cannot be dodged with spaces or slashes. */
  static normalizePath(rawPath: string): string {
    const { valid, cleanPath } = ExecutionAdapter.sanitizeFilePath(rawPath);
    return valid ? cleanPath : rawPath;
  }

  private static actionPaths(action: { [key: string]: any }): string[] {
    return [action.path, action.oldPath, action.newPath]
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map(p => this.normalizePath(p));
  }

  /**
   * Identifies the proposed changes to each file. Every action on a path counts, in order,
   * so an approval for one change does not cover a different or additional change.
   */
  static fingerprintActions(actions: Array<{ [key: string]: any }>): Record<string, string> {
    const perPath = new Map<string, unknown[]>();
    for (const action of actions) {
      const paths = this.actionPaths(action);
      const change = action.action === 'rename_file'
        ? ['rename_file', ...paths]
        : action.action === 'delete_file'
          ? ['delete_file']
          : action.action === 'patch_file'
            ? ['patch_file', action.edits, action.find, action.replace]
            : ['create_file', action.content];
      for (const path of paths) perPath.set(path, [...(perPath.get(path) || []), change]);
    }

    return Object.fromEntries(Array.from(perPath, ([path, changes]) => [
      path,
      crypto.createHash('sha256').update(JSON.stringify(changes)).digest('hex')
    ]));
  }

  /** Text the owner reviews. Everything that an approval would apply is listed. */
  private static describeActions(actions: Array<{ [key: string]: any }>): string {
    return actions.map(action => {
      // Show what the store will apply for this kind of action, and nothing else
      const body = action.action === 'patch_file'
        ? JSON.stringify(action.edits ?? [action.find, action.replace], null, 2)
        : action.action === 'create_file' ? action.content : '';
      return `--- ${this.actionPaths(action).join(' -> ')} (${action.action})\n${body}`;
    }).join('\n\n');
  }

  /**
   * Creates a request for exactly these changes. Patches record the file version,
   * so an approved patch cannot land on a file that changed after review.
   */
  static requestForActions(
    buildId: string,
    userId: string,
    params: {
      agent: string;
      actions: Array<{ [key: string]: any }>;
      runId?: string;
      taskId?: string;
      /** Tasks from the same response. They are created only if the owner approves. */
      followUpTasks?: Array<{ [key: string]: any }>;
      /** Evidence shown to the owner next to the change. */
      reviewResults?: string;
      explanation?: string;
    }
  ): { success: boolean; request?: HumanApprovalRequest; error?: string } {
    const fingerprints = this.fingerprintActions(params.actions);
    const sensitive = Object.keys(fingerprints).filter(p => this.isSensitiveFilePath(p));
    const contentHashes = Object.fromEntries(sensitive.map(p => [p, fingerprints[p]]));

    const duplicate = db.getApprovalRequests(buildId, 'pending').find(r =>
      JSON.stringify(r.contentHashes) === JSON.stringify(contentHashes) &&
      r.patchId === params.runId &&
      r.taskId === params.taskId &&
      Date.now() <= r.createdAt + APPROVAL_TTL_MS
    );
    if (duplicate) return { success: true, request: duplicate };

    // Only the first patch to a file is checked, because later ones build on it
    const versionChecked = new Set<string>();

    return this.requestApproval(buildId, userId, {
      patchId: params.runId,
      taskId: params.taskId,
      requestingAgent: params.agent,
      requestingRole: 'security_specialist',
      operationType: 'security_sensitive_change',
      explanation: params.explanation || `Generated code changes sensitive files: ${sensitive.join(', ')}`,
      reviewResults: params.reviewResults,
      affectedFiles: sensitive,
      proposedChanges: [
        this.describeActions(params.actions),
        ...(params.followUpTasks || []).map(task => `--- New task: ${task.title}\n${task.description || ''}`)
      ].join('\n\n'),
      contentHashes,
      proposedActions: [...params.actions.map(action => {
        if (action.action !== 'patch_file') return action;
        const path = this.normalizePath(action.path);
        if (versionChecked.has(path)) return action;
        versionChecked.add(path);
        const file = db.getFile(buildId, path);
        return file ? { ...action, expectedVersion: file.version } : action;
      }), ...(params.followUpTasks || [])],
      riskLevel: 'high'
    });
  }

  /** Splits a batch into changes that can apply now, and changes that need the owner. */
  static splitSensitiveActions(
    buildId: string,
    actions: Array<{ [key: string]: any }>
  ): { ready: Array<{ [key: string]: any }>; held: Array<{ [key: string]: any }> } {
    const fingerprints = this.fingerprintActions(actions);
    const blocked = Object.keys(fingerprints).filter(p =>
      this.isSensitiveFilePath(p) && !this.hasApprovedRequestForFiles(buildId, [p], fingerprints)
    );
    const isHeld = (action: { [key: string]: any }) => this.actionPaths(action).some(p => blocked.includes(p));
    return { ready: actions.filter(action => !isHeld(action)), held: actions.filter(isHeld) };
  }

  /** The owner's latest decision on a file is the one that counts. */
  private static latestDecision(buildId: string, file: string): HumanApprovalRequest | undefined {
    return db.getApprovalRequests(buildId)
      .filter(a =>
        a.buildId === buildId &&
        (a.status === 'approved' || a.status === 'rejected') &&
        Array.isArray(a.affectedFiles) &&
        a.affectedFiles.includes(file)
      )
      // On a tie the rejection wins
      .sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0) || (a.status === 'rejected' ? -1 : 1))[0];
  }

  /**
   * Checks that every sensitive file has a live, unused approval for this exact change.
   * Validity runs from creation. An approval without a fingerprint authorizes nothing.
   */
  static hasApprovedRequestForFiles(buildId: string, files: string[], fingerprints: Record<string, string> = {}): boolean {
    if (!files || files.length === 0) return true;
    const sensitiveFiles = files.filter(f => this.isSensitiveFilePath(f));
    if (sensitiveFiles.length === 0) return true;

    const now = Date.now();
    return sensitiveFiles.every(file => {
      const decision = this.latestDecision(buildId, file);
      if (!decision || decision.status !== 'approved') return false;
      if (now > decision.createdAt + APPROVAL_TTL_MS) return false;
      if (decision.consumedFiles?.includes(file)) return false;

      const expected = decision.contentHashes?.[file];
      return expected !== undefined && expected === fingerprints[file];
    });
  }

  /** Marks approvals as used, so one approval cannot cover a second change. */
  static consumeApprovedFiles(buildId: string, files: string[]): void {
    for (const file of files) {
      const decision = this.latestDecision(buildId, file);
      if (decision?.status !== 'approved') continue;
      db.saveApprovalRequest({ ...decision, consumedFiles: [...(decision.consumedFiles || []), file] });
    }
  }

  /** Withdraws an approval. Anything already applied stays applied. */
  static revokeApproval(
    buildId: string,
    userId: string,
    requestId: string,
    notes = 'Approval revoked by the owner'
  ): { success: boolean; request?: HumanApprovalRequest; error?: string } {
    const build = db.getBuild(buildId);
    if (!userId || !build || !build.userId || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }
    const request = db.getApprovalRequest(requestId);
    if (!request || request.buildId !== buildId) {
      return { success: false, error: `Approval request ${requestId} not found in this build` };
    }
    if (request.status !== 'approved') {
      return { success: false, error: `Only an approved request can be revoked (status: ${request.status})` };
    }
    const revoked = db.saveApprovalRequest({
      ...request,
      status: 'rejected',
      resolutionNotes: notes,
      resolvedAt: Date.now()
    });
    return { success: true, request: revoked };
  }

  /** After Stop, nothing waiting on the owner should write to the build. */
  static cancelTaskRequests(buildId: string): void {
    for (const request of db.getApprovalRequests(buildId, 'pending')) {
      if (request.taskId && !request.patchId) {
        db.saveApprovalRequest({ ...request, status: 'cancelled', resolvedAt: Date.now() });
      }
    }
  }

  static hasExpired(request: HumanApprovalRequest): boolean {
    return Date.now() > request.createdAt + APPROVAL_TTL_MS;
  }

  /** Withdraws one unanswered request. */
  static cancelRequest(buildId: string, requestId: string): void {
    const request = db.getApprovalRequest(requestId);
    if (request?.buildId === buildId && request.status === 'pending') {
      db.saveApprovalRequest({ ...request, status: 'cancelled', resolvedAt: Date.now() });
    }
  }

  /** A request left by a cancelled run must not unlock files later. */
  static cancelRequestsForRun(buildId: string, runId: string): void {
    for (const request of db.getApprovalRequests(buildId, 'pending')) {
      if (request.patchId === runId) {
        db.saveApprovalRequest({ ...request, status: 'cancelled', resolvedAt: Date.now() });
      }
    }
  }

  /**
   * Checks for a live approval of one operation on one exact workspace.
   * Validity runs from creation, so changed code always needs a new approval.
   */
  static hasApprovedScope(buildId: string, operationType: ApprovalOperationType, scopeHash: string): boolean {
    const now = Date.now();
    return db.getApprovalRequests(buildId, 'approved').some(a =>
      a.operationType === operationType &&
      a.scopeHash === scopeHash &&
      now <= a.createdAt + APPROVAL_TTL_MS
    );
  }

  /** Finds a pending request for one operation on one exact workspace. */
  static findPendingScope(
    buildId: string,
    operationType: ApprovalOperationType,
    scopeHash: string
  ): HumanApprovalRequest | undefined {
    const now = Date.now();
    return db.getApprovalRequests(buildId, 'pending').find(a =>
      a.operationType === operationType &&
      a.scopeHash === scopeHash &&
      now <= a.createdAt + APPROVAL_TTL_MS
    );
  }

  /**
   * Creates a formal human approval request for restricted operations
   */
  static requestApproval(
    buildId: string,
    userId: string,
    params: {
      taskId?: string;
      patchId?: string;
      requestingAgent: string;
      requestingRole: AgentRole;
      operationType: ApprovalOperationType;
      explanation: string;
      riskLevel?: 'low' | 'medium' | 'high' | 'critical';
      affectedFiles: string[];
      proposedChanges: string;
      reviewResults?: string;
      testResults?: string;
      scopeHash?: string;
      contentHashes?: Record<string, string>;
      proposedActions?: any[];
    }
  ): { success: boolean; request?: HumanApprovalRequest; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const reqId = `appr_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const riskLevel = params.riskLevel || (
      params.operationType === 'destructive_file_op' || params.operationType === 'project_rollback' ? 'high' : 'medium'
    );

    const approvalReq: HumanApprovalRequest = {
      id: reqId,
      buildId,
      taskId: params.taskId,
      patchId: params.patchId,
      requestingAgent: params.requestingAgent,
      requestingRole: params.requestingRole,
      operationType: params.operationType,
      explanation: params.explanation,
      riskLevel,
      affectedFiles: params.affectedFiles,
      proposedChanges: params.proposedChanges,
      reviewResults: params.reviewResults,
      testResults: params.testResults,
      scopeHash: params.scopeHash,
      contentHashes: params.contentHashes,
      proposedActions: params.proposedActions,
      status: 'pending',
      createdAt: Date.now()
    };

    db.saveApprovalRequest(approvalReq);

    // Update requesting agent status
    db.updateAgentStatus(buildId, params.requestingRole, 'awaiting_approval', `Awaiting user approval for ${params.operationType}`, params.taskId);

    // Swarm event
    db.addEvent({
      id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      buildId,
      timestamp: Date.now(),
      type: 'approval_requested',
      modelId: params.requestingAgent,
      taskId: params.taskId,
      filePath: params.affectedFiles?.[0],
      details: `Human approval requested by ${params.requestingRole} for [${params.operationType}] (Risk: ${riskLevel.toUpperCase()}): "${params.explanation.slice(0, 70)}"`
    });

    return { success: true, request: approvalReq };
  }

  /**
   * Responds to an approval request (User human gate response).
   *
   * userId must be the authenticated session user, and only the build owner may decide.
   * The recorded approver is always that user. approvedBy is a caller claim that can only
   * block a decision (for example, an agent acting as approver). It never grants access.
   */
  static respondToApproval(
    buildId: string,
    userId: string,
    params: {
      requestId: string;
      approved: boolean;
      approvedBy?: string;
      resolutionNotes?: string;
    }
  ): { success: boolean; request?: HumanApprovalRequest; error?: string };
  static respondToApproval(
    buildId: string,
    requestId: string,
    statusOrApproved: 'approved' | 'rejected' | boolean,
    userId?: string,
    resolutionNotes?: string
  ): { success: boolean; request?: HumanApprovalRequest; error?: string };
  static respondToApproval(
    buildId: string,
    arg2: string,
    arg3: any,
    arg4?: string,
    arg5?: string
  ): { success: boolean; request?: HumanApprovalRequest; error?: string } {
    let effectiveUserId: string | undefined;
    let requestId: string;
    let approved: boolean;
    let claimedActor: string | undefined;
    let resolutionNotes: string | undefined;

    if (typeof arg3 === 'object' && arg3 !== null && 'requestId' in arg3) {
      effectiveUserId = arg2;
      requestId = arg3.requestId;
      approved = Boolean(arg3.approved);
      claimedActor = arg3.approvedBy;
      resolutionNotes = arg3.resolutionNotes;
    } else {
      requestId = arg2;
      approved = typeof arg3 === 'boolean' ? arg3 : (arg3 === 'approved');
      effectiveUserId = arg4;
      resolutionNotes = arg5;
    }

    const build = db.getBuild(buildId);
    if (!effectiveUserId || !build || !build.userId || build.userId !== effectiveUserId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const request = db.getApprovalRequest(requestId);
    if (!request || request.buildId !== buildId) {
      return { success: false, error: `Approval request ${requestId} not found in this build` };
    }

    // STRICT IDEMPOTENCY / REPEATED DECISION GUARD:
    // Reject repeated or conflicting decisions on already resolved requests
    if (request.status !== 'pending') {
      return {
        success: false,
        error: `Conflict: Approval request ${requestId} is already resolved (${request.status}) and cannot be modified.`
      };
    }

    // STRICT ANTI-BYPASS: Agents cannot approve restricted operations; must be authenticated human user
    if ([effectiveUserId, claimedActor].some(actor => actor && this.isAgentActor(actor, request))) {
      return {
        success: false,
        error: 'Forbidden: Agents cannot approve their own restricted operations. Human approval is strictly required.'
      };
    }

    // An unanswered request cannot be decided after its validity window closes
    if (Date.now() > request.createdAt + APPROVAL_TTL_MS) {
      request.status = 'expired';
      request.resolvedAt = Date.now();
      db.saveApprovalRequest(request);
      return { success: false, error: `Approval request ${requestId} has expired and cannot be decided.` };
    }

    const newStatus: ApprovalStatus = approved ? 'approved' : 'rejected';
    request.status = newStatus;
    request.approvedBy = effectiveUserId;
    request.resolutionNotes = resolutionNotes;
    request.resolvedAt = Date.now();

    db.saveApprovalRequest(request);

    // Update agent state
    db.updateAgentStatus(
      buildId, 
      request.requestingRole, 
      approved ? 'working' : 'idle', 
      `Approval request ${newStatus} by ${effectiveUserId}`,
      request.taskId
    );

    // Swarm event
    db.addEvent({
      id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      buildId,
      timestamp: Date.now(),
      type: 'approval_responded',
      taskId: request.taskId,
      details: `Approval request for [${request.operationType}] ${newStatus.toUpperCase()} by ${effectiveUserId}`
    });

    return { success: true, request };
  }

  private static isAgentActor(actor: string, request: HumanApprovalRequest): boolean {
    const normalized = actor.toLowerCase();
    return normalized.startsWith('agent_') ||
      KNOWN_AGENT_ROLES.includes(normalized) ||
      actor === request.requestingAgent ||
      actor === request.requestingRole;
  }
}
