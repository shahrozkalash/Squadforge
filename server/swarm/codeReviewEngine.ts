import crypto from 'node:crypto';
import { db } from '../store.js';
import { 
  CodeReview, 
  CodeReviewComment, 
  CodeReviewVerdict, 
  CodeReviewChecks,
  AgentRole 
} from '../types.js';

export class CodeReviewEngine {
  /**
   * Submits implementation changes for independent code review.
   * Prevents self-review: authorAgent cannot be reviewerAgent.
   */
  static submitForReview(
    buildId: string,
    userId: string,
    params: {
      taskId: string;
      patchId?: string;
      authorAgent: string;
      authorRole: AgentRole;
      reviewerRole?: AgentRole;
      changedFiles: string[];
      baseVersions: Record<string, number>;
      proposedChanges: Array<{ filePath: string; action: string; diffSnippet?: string }>;
      requirementsAddressed: string[];
      implementationExplanation: string;
      testEvidence: string;
    }
  ): { success: boolean; review?: CodeReview; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    // Select independent reviewer agent
    let reviewerRole: AgentRole = params.reviewerRole || 'qa_testing_specialist';
    if (reviewerRole === params.authorRole) {
      reviewerRole = params.authorRole === 'software_architect' ? 'security_specialist' : 'software_architect';
    }

    const reviewerProfile = db.getAgentProfile(buildId, reviewerRole);
    const reviewerAgent = reviewerProfile?.name || `${reviewerRole}_agent`;

    if (params.authorAgent === reviewerAgent) {
      return {
        success: false,
        error: 'Self-review forbidden: An agent cannot review its own implementation.'
      };
    }

    const reviewId = `rev_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    // Evaluate initial checks based on provided evidence rather than blindly defaulting to true
    const hasEvidence = Boolean(params.testEvidence && params.testEvidence.trim().length > 10);
    const hasChanges = Array.isArray(params.proposedChanges) && params.proposedChanges.length > 0;

    const initialChecks: CodeReviewChecks = {
      logicCorrectness: hasEvidence,
      errorHandling: true,
      security: true,
      inputValidation: true,
      apiCompatibility: true,
      databaseIntegrity: true,
      performance: true,
      maintainability: true,
      architectureConsistency: true,
      dependencyRisks: true,
      testCoverage: hasEvidence,
      requirementCompliance: hasChanges
    };

    const review: CodeReview = {
      id: reviewId,
      buildId,
      taskId: params.taskId,
      patchId: params.patchId,
      authorAgent: params.authorAgent,
      authorRole: params.authorRole,
      reviewerAgent,
      reviewerRole,
      changedFiles: params.changedFiles,
      baseVersions: params.baseVersions,
      proposedChanges: params.proposedChanges,
      requirementsAddressed: params.requirementsAddressed,
      implementationExplanation: params.implementationExplanation,
      explanation: params.implementationExplanation,
      testEvidence: params.testEvidence,
      verdict: 'pending', // STRICT: Pending reviews must NEVER be treated as approved!
      status: 'pending',
      reviewChecks: initialChecks,
      checks: initialChecks as any,
      comments: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    db.saveCodeReview(review);

    // Update agent statuses
    db.updateAgentStatus(buildId, params.authorRole, 'awaiting_review', `Submitted review ${reviewId} for task ${params.taskId}`, params.taskId);
    db.updateAgentStatus(buildId, reviewerRole, 'assigned', `Assigned code review ${reviewId} from ${params.authorAgent}`, params.taskId);

    // Log Swarm Event
    db.addEvent({
      id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      buildId,
      timestamp: Date.now(),
      type: 'code_review_requested',
      modelId: params.authorAgent,
      taskId: params.taskId,
      filePath: params.changedFiles[0],
      details: `Code review requested by ${params.authorRole} -> assigned to ${reviewerRole} on ${params.changedFiles.join(', ')}`
    });

    return { success: true, review };
  }

  /**
   * Adds a line-level comment on exact file locations.
   * Validates multi-tenant isolation, file existence, and valid line ranges.
   */
  static addComment(
    buildId: string,
    userId: string,
    params: {
      reviewId: string;
      filePath: string;
      startLine: number;
      endLine: number;
      severity: 'nit' | 'suggestion' | 'warning' | 'critical';
      explanation: string;
      suggestedCorrection?: string;
      relatedRequirement?: string;
      author: string;
      authorRole: AgentRole;
    }
  ): { success: boolean; comment?: CodeReviewComment; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const review = db.getCodeReview(params.reviewId);
    if (!review || review.buildId !== buildId) {
      return { success: false, error: `Review ${params.reviewId} not found in this build` };
    }

    if (params.startLine < 1 || params.endLine < params.startLine) {
      return { success: false, error: `Invalid line range: lines must be >= 1 and endLine >= startLine` };
    }

    const commentId = `cm_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const comment: CodeReviewComment = {
      id: commentId,
      reviewId: params.reviewId,
      buildId,
      filePath: params.filePath,
      startLine: Math.max(1, params.startLine),
      endLine: Math.max(params.startLine, params.endLine),
      severity: params.severity,
      explanation: params.explanation,
      suggestedCorrection: params.suggestedCorrection,
      relatedRequirement: params.relatedRequirement,
      status: 'open',
      author: params.author,
      authorRole: params.authorRole,
      timestamp: Date.now()
    };

    db.addReviewComment(comment);
    return { success: true, comment };
  }

  /**
   * Submits a formal review verdict with checks evaluation.
   * Enforces that reviewer is authorized, critical findings block approval,
   * and changes requested trigger revision workflow.
   */
  static submitVerdict(
    buildId: string,
    userId: string,
    params: {
      reviewId: string;
      reviewerAgent: string;
      verdict: CodeReviewVerdict;
      checks?: Partial<CodeReviewChecks>;
      summaryComments?: string;
    }
  ): { success: boolean; review?: CodeReview; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const review = db.getCodeReview(params.reviewId);
    if (!review || review.buildId !== buildId) {
      return { success: false, error: `Review ${params.reviewId} not found in this build` };
    }

    // STRICT ANTI-BYPASS: Author cannot review or approve their own submission
    if (params.reviewerAgent === review.authorAgent || params.reviewerAgent === review.authorRole) {
      return {
        success: false,
        error: 'Forbidden: Author cannot submit verdict on their own review submission'
      };
    }

    if (review.status === 'completed') {
      return {
        success: false,
        error: `Review ${params.reviewId} is already completed and cannot accept new verdicts`
      };
    }

    // Merge checks
    const updatedChecks: CodeReviewChecks = {
      ...review.reviewChecks,
      ...(params.checks || {})
    };

    // If critical comments exist or security/logic failed, cannot be approved without changes
    const comments = db.getReviewComments(review.id);
    const hasCritical = comments.some(c => c.severity === 'critical' && c.status === 'open');
    const failedCoreChecks = !updatedChecks.security || !updatedChecks.logicCorrectness;

    let finalVerdict = params.verdict;

    if ((hasCritical || failedCoreChecks) && (finalVerdict === 'approved' || finalVerdict === 'approved_with_suggestions')) {
      finalVerdict = 'changes_requested';
    }

    review.verdict = finalVerdict;
    review.reviewChecks = updatedChecks;
    review.checks = updatedChecks as any;
    review.status = finalVerdict === 'changes_requested' ? 'revising' : 'completed';
    review.updatedAt = Date.now();

    db.saveCodeReview(review);

    // Update agent state
    if (finalVerdict === 'changes_requested') {
      db.updateAgentStatus(buildId, review.authorRole, 'revising', `Revising changes per review ${review.id}`, review.taskId);
    } else if (finalVerdict === 'approved' || finalVerdict === 'approved_with_suggestions') {
      db.updateAgentStatus(buildId, review.authorRole, 'working', `Review ${review.id} approved, ready for integration`, review.taskId);
    }

    // Emit event
    db.addEvent({
      id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      buildId,
      timestamp: Date.now(),
      type: 'code_review_completed',
      modelId: params.reviewerAgent,
      taskId: review.taskId,
      filePath: review.changedFiles[0],
      details: `Code review verdict: [${finalVerdict.toUpperCase()}] by ${params.reviewerAgent} on task ${review.taskId}`
    });

    return { success: true, review };
  }

  /**
   * Submits a revised implementation addressing changes requested in a code review
   */
  static submitRevision(
    buildId: string,
    userId: string,
    params: {
      reviewId: string;
      authorAgent: string;
      revisionExplanation: string;
      newTestEvidence?: string;
      revisedChanges?: Array<{ filePath: string; action: string; diffSnippet?: string }>;
    }
  ): { success: boolean; review?: CodeReview; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const review = db.getCodeReview(params.reviewId);
    if (!review || review.buildId !== buildId) {
      return { success: false, error: `Review ${params.reviewId} not found in this build` };
    }

    // Reset status to under_review, verdict to pending for independent re-review
    review.status = 'under_review';
    review.verdict = 'pending';
    review.implementationExplanation = `${review.implementationExplanation}\n\nRevision: ${params.revisionExplanation}`;
    review.explanation = review.implementationExplanation;
    if (params.newTestEvidence) {
      review.testEvidence = params.newTestEvidence;
    }
    if (params.revisedChanges && params.revisedChanges.length > 0) {
      review.proposedChanges = params.revisedChanges;
    }
    review.updatedAt = Date.now();

    db.saveCodeReview(review);

    db.updateAgentStatus(buildId, review.authorRole, 'awaiting_review', `Submitted revised implementation for review ${review.id}`, review.taskId);
    db.updateAgentStatus(buildId, review.reviewerRole, 'assigned', `Assigned re-review of revised implementation ${review.id}`, review.taskId);

    return { success: true, review };
  }
}
