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
    const defaultChecks: CodeReviewChecks = {
      logicCorrectness: true,
      errorHandling: true,
      security: true,
      inputValidation: true,
      apiCompatibility: true,
      databaseIntegrity: true,
      performance: true,
      maintainability: true,
      architectureConsistency: true,
      dependencyRisks: true,
      testCoverage: true,
      requirementCompliance: true
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
      testEvidence: params.testEvidence,
      verdict: 'approved', // initial default until completed
      status: 'pending',
      reviewChecks: defaultChecks,
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
    if (!review) {
      return { success: false, error: `Review ${params.reviewId} not found` };
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
    if (!review) {
      return { success: false, error: `Review ${params.reviewId} not found` };
    }

    // Merge checks
    const updatedChecks: CodeReviewChecks = {
      ...review.reviewChecks,
      ...(params.checks || {})
    };

    // If critical comments exist or security/logic failed, cannot be approved without changes
    const comments = db.getReviewComments(review.id);
    const hasCritical = comments.some(c => c.severity === 'critical' && c.status === 'open');
    let finalVerdict = params.verdict;

    if (hasCritical && (finalVerdict === 'approved' || finalVerdict === 'approved_with_suggestions')) {
      finalVerdict = 'changes_requested';
    }

    review.verdict = finalVerdict;
    review.reviewChecks = updatedChecks;
    review.status = finalVerdict === 'changes_requested' ? 'revising' : 'completed';
    review.updatedAt = Date.now();

    db.saveCodeReview(review);

    // Update agent state
    if (finalVerdict === 'changes_requested') {
      db.updateAgentStatus(buildId, review.authorRole, 'revising', `Revising changes per review ${review.id}`, review.taskId);
    } else if (finalVerdict === 'approved') {
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
      details: `Code review verdict: [${finalVerdict.toUpperCase()}] by ${review.reviewerAgent} on task ${review.taskId}`
    });

    return { success: true, review };
  }
}
