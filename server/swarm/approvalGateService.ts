import crypto from 'node:crypto';
import { db } from '../store.js';
import { 
  HumanApprovalRequest, 
  ApprovalOperationType, 
  ApprovalStatus, 
  AgentRole 
} from '../types.js';

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
   * Strict security check: Agents CANNOT approve their own restricted operations.
   */
  static respondToApproval(
    buildId: string,
    userId: string,
    params: {
      requestId: string;
      approved: boolean;
      approvedBy: string; // Must be user ID or human identity, never an AI agent role
      resolutionNotes?: string;
    }
  ): { success: boolean; request?: HumanApprovalRequest; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const request = db.getApprovalRequest(params.requestId);
    if (!request) {
      return { success: false, error: `Approval request ${params.requestId} not found` };
    }

    // STRICT ANTI-BYPASS: Agents cannot approve their own restricted operations
    if (params.approvedBy === request.requestingAgent || params.approvedBy === request.requestingRole) {
      return {
        success: false,
        error: 'Forbidden: Agents cannot approve their own restricted operations. Human approval is strictly required.'
      };
    }

    const newStatus: ApprovalStatus = params.approved ? 'approved' : 'rejected';
    request.status = newStatus;
    request.approvedBy = params.approvedBy;
    request.resolutionNotes = params.resolutionNotes;
    request.resolvedAt = Date.now();

    db.saveApprovalRequest(request);

    // Update agent state
    db.updateAgentStatus(
      buildId, 
      request.requestingRole, 
      params.approved ? 'working' : 'idle', 
      `Approval request ${newStatus} by ${params.approvedBy}`,
      request.taskId
    );

    // Swarm event
    db.addEvent({
      id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      buildId,
      timestamp: Date.now(),
      type: 'approval_responded',
      taskId: request.taskId,
      details: `Approval request for [${request.operationType}] ${newStatus.toUpperCase()} by ${params.approvedBy}`
    });

    return { success: true, request };
  }
}
