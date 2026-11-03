import crypto from 'node:crypto';
import { db } from '../store.js';
import { 
  CollaborativeDefect, 
  DefectStatus, 
  DefectSeverity, 
  DefectSolution,
  AgentRole 
} from '../types.js';

export class CollaborativeDebuggingEngine {
  /**
   * Records a new defect discovered in the shared workspace.
   */
  static recordDefect(
    buildId: string,
    userId: string,
    params: {
      taskId?: string;
      title: string;
      description: string;
      severity: DefectSeverity;
      reproductionSteps: string[];
      expectedBehavior: string;
      actualBehavior: string;
      affectedFiles: string[];
      assignedAgent?: string;
      authorRole?: AgentRole;
    }
  ): { success: boolean; defect?: CollaborativeDefect; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const defectId = `def_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const assignedAgent = params.assignedAgent || 'debugging_specialist';

    const defect: CollaborativeDefect = {
      id: defectId,
      buildId,
      taskId: params.taskId,
      title: params.title,
      description: params.description,
      severity: params.severity,
      status: 'open',
      reproductionSteps: params.reproductionSteps || [],
      expectedBehavior: params.expectedBehavior,
      actualBehavior: params.actualBehavior,
      affectedFiles: params.affectedFiles || [],
      assignedAgents: [assignedAgent],
      proposedSolutions: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    db.saveDefect(defect);

    // Update debugging agent status
    db.updateAgentStatus(buildId, 'debugging_specialist', 'assigned', `Assigned defect investigation: ${params.title}`, params.taskId);

    // Swarm event
    db.addEvent({
      id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      buildId,
      timestamp: Date.now(),
      type: 'defect_reported',
      taskId: params.taskId,
      filePath: params.affectedFiles?.[0],
      details: `Defect reported [${params.severity.toUpperCase()}]: "${params.title}" affecting ${params.affectedFiles.join(', ')}`
    });

    return { success: true, defect };
  }

  /**
   * Adds a root cause hypothesis or proposed fix solution to a defect.
   */
  static proposeSolution(
    buildId: string,
    userId: string,
    params: {
      defectId: string;
      author: string;
      authorRole?: AgentRole;
      rootCause?: string;
      proposal: string;
      patchId?: string;
      score?: number;
    }
  ): { success: boolean; defect?: CollaborativeDefect; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const defect = db.getDefect(params.defectId);
    if (!defect) {
      return { success: false, error: `Defect ${params.defectId} not found` };
    }

    if (params.rootCause) {
      defect.rootCause = params.rootCause;
      defect.status = 'identified';
    }

    const solution: DefectSolution = {
      solutionId: `sol_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
      author: params.author,
      authorRole: params.authorRole,
      proposal: params.proposal,
      patchId: params.patchId,
      score: params.score || 85
    };

    defect.proposedSolutions.push(solution);
    if (params.patchId) {
      defect.selectedPatchId = params.patchId;
      defect.status = 'fixing';
    }
    defect.updatedAt = Date.now();

    db.saveDefect(defect);
    return { success: true, defect };
  }

  /**
   * Updates defect status with strict verification requirement.
   * A defect CANNOT be marked 'resolved' without explicit test evidence and verification output.
   */
  static updateStatus(
    buildId: string,
    userId: string,
    params: {
      defectId: string;
      status: DefectStatus;
      verificationEvidence?: {
        syntaxPassed: boolean;
        testsPassed: boolean;
        evidenceText: string;
      };
      testEvidence?: string;
    }
  ): { success: boolean; defect?: CollaborativeDefect; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const defect = db.getDefect(params.defectId);
    if (!defect) {
      return { success: false, error: `Defect ${params.defectId} not found` };
    }

    // STRICT HONESTY GUARD: Cannot mark resolved without verification evidence
    if (params.status === 'resolved') {
      if (!params.verificationEvidence && !params.testEvidence) {
        return {
          success: false,
          error: 'Verification required: Cannot mark defect resolved without execution and test verification evidence.'
        };
      }
      if (params.verificationEvidence && (!params.verificationEvidence.syntaxPassed || !params.verificationEvidence.testsPassed)) {
        return {
          success: false,
          error: 'Verification failed: Automated checks or tests did not pass.'
        };
      }
      defect.resolvedAt = Date.now();
    }

    defect.status = params.status;
    if (params.testEvidence) {
      defect.testEvidence = params.testEvidence;
    }
    if (params.verificationEvidence) {
      defect.verificationDetails = {
        syntaxPassed: params.verificationEvidence.syntaxPassed,
        testsPassed: params.verificationEvidence.testsPassed,
        evidenceText: params.verificationEvidence.evidenceText,
        verifiedAt: Date.now()
      };
    }
    defect.updatedAt = Date.now();

    db.saveDefect(defect);

    // Swarm event
    if (params.status === 'resolved') {
      db.addEvent({
        id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        buildId,
        timestamp: Date.now(),
        type: 'defect_resolved',
        taskId: defect.taskId,
        filePath: defect.affectedFiles?.[0],
        details: `Defect resolved with verified evidence: "${defect.title}"`
      });
    }

    return { success: true, defect };
  }
}
