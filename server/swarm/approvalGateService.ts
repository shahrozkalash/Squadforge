import crypto from 'node:crypto';
import { db } from '../store.js';
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
        return true;
      case 'multi_file_wide_modification':
        return affectedFilesCount > 5;
      case 'large_dependency_change':
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
      /(?:^|\/)server\/(?:crypto|email|db\/database|gateway)\.ts$/,
      /\b(auth|crypto|secret|password|credential|token|session|security|permission)\b/i,
      /(?:^|\/)migrations\//
    ];
    return sensitivePatterns.some(pattern => pattern.test(normalized));
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

  /**
   * Checks whether an approved human approval request exists for the specified files.
   * Every sensitive file must be explicitly covered by a valid, active, non-expired, non-rejected approval.
   */
  static hasApprovedRequestForFiles(buildId: string, files: string[]): boolean {
    if (!files || files.length === 0) return true;
    const sensitiveFiles = files.filter(f => this.isSensitiveFilePath(f));
    if (sensitiveFiles.length === 0) return true;

    const approvals = db.getApprovalRequests(buildId);
    const now = Date.now();

    // Every sensitive file must have a valid approval belonging to this exact build
    return sensitiveFiles.every(file => {
      return approvals.some(a => {
        if (a.buildId !== buildId) return false;
        if (a.status !== 'approved') return false;
        // Check for expired approval
        if (a.resolvedAt && (now - a.resolvedAt) > APPROVAL_TTL_MS) return false;
        if ((a as any).expiresAt && now > (a as any).expiresAt) return false;
        // Verify affected file is explicitly listed
        return Array.isArray(a.affectedFiles) && a.affectedFiles.includes(file);
      });
    });
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
