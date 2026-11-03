import crypto from 'node:crypto';
import { db } from '../store.js';
import { 
  AIChallenge, 
  AIChallengeArgument, 
  AIChallengeSubject, 
  AIChallengeOutcome, 
  AgentRole,
  SharedKnowledgeItem 
} from '../types.js';

export class AIChallengeEngine {
  private static MAX_ROUNDS = 3; // Strict round limit to prevent endless disagreement

  /**
   * Starts a formal AI Challenge session on an architecture or technical proposal
   */
  static startChallenge(
    buildId: string,
    userId: string,
    params: {
      taskId?: string;
      subject: AIChallengeSubject;
      originalProposal: string;
      proposerAgent: string;
      proposerRole: AgentRole;
      challengerRole?: AgentRole;
    }
  ): { success: boolean; challenge?: AIChallenge; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    // Select challenger role
    let challengerRole: AgentRole = params.challengerRole || 'security_specialist';
    if (challengerRole === params.proposerRole) {
      challengerRole = params.proposerRole === 'software_architect' ? 'security_specialist' : 'software_architect';
    }

    const challengerProfile = db.getAgentProfile(buildId, challengerRole);
    const challengerAgent = challengerProfile?.name || `${challengerRole}_agent`;

    const challengeId = `chal_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const challenge: AIChallenge = {
      id: challengeId,
      buildId,
      taskId: params.taskId,
      subject: params.subject,
      originalProposal: params.originalProposal,
      proposerAgent: params.proposerAgent,
      proposerRole: params.proposerRole,
      challengerAgent,
      challengerRole,
      currentRound: 1,
      maxRounds: this.MAX_ROUNDS,
      status: 'active',
      outcome: 'pending',
      participants: [params.proposerAgent, challengerAgent],
      arguments: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    db.saveAIChallenge(challenge);

    // Initial argument by proposer
    const initialArg: AIChallengeArgument = {
      id: `arg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      challengeId,
      roundNumber: 1,
      authorAgent: params.proposerAgent,
      authorRole: params.proposerRole,
      argumentType: 'pro',
      claim: `Proposal: ${params.subject} implementation`,
      evidence: params.originalProposal,
      identifiedRisks: [],
      timestamp: Date.now()
    };
    (initialArg as any).buildId = buildId;

    db.addChallengeArgument(initialArg);

    // Log swarm event
    db.addEvent({
      id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      buildId,
      timestamp: Date.now(),
      type: 'ai_challenge_started',
      modelId: params.proposerAgent,
      taskId: params.taskId,
      details: `AI Challenge initiated on [${params.subject}]: ${params.proposerRole} challenged by ${challengerRole}`
    });

    return { success: true, challenge };
  }

  /**
   * Adds an argument, critique, or counter-proposal to an ongoing challenge session
   */
  static addArgument(
    buildId: string,
    userId: string,
    params: {
      challengeId: string;
      authorAgent?: string;
      authorRole: AgentRole;
      round?: number;
      argumentType: 'pro' | 'con' | 'alternative' | 'counter_evidence' | 'risk' | 'defense';
      claim?: string;
      argument?: string;
      evidence?: string;
      proposedAlternative?: string;
      identifiedRisks?: string[];
    }
  ): { success: boolean; argument?: AIChallengeArgument; challenge?: AIChallenge; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const challenge = db.getAIChallenge(params.challengeId);
    if (!challenge) {
      return { success: false, error: `Challenge ${params.challengeId} not found` };
    }

    if (challenge.status !== 'active') {
      return { success: false, error: `Challenge ${params.challengeId} is already ${challenge.status}` };
    }

    // Check round progression & round limits
    if (params.round && params.round > this.MAX_ROUNDS) {
      return {
        success: false,
        error: `Cannot exceed maximum of ${this.MAX_ROUNDS} debate rounds for challenge ${params.challengeId}`
      };
    }

    const existingArgs = db.getChallengeArguments(params.challengeId);
    let nextRound = params.round || challenge.currentRound;

    // Increment round if switching speakers and not explicitly passed
    const lastArg = existingArgs[existingArgs.length - 1];
    if (!params.round && lastArg && lastArg.authorRole !== params.authorRole) {
      nextRound = challenge.currentRound + 1;
    }

    if (nextRound > this.MAX_ROUNDS) {
      return {
        success: false,
        error: `Cannot exceed maximum of ${this.MAX_ROUNDS} debate rounds for challenge ${params.challengeId}`
      };
    }

    const authorAgent = params.authorAgent || `${params.authorRole}_agent`;
    const claim = params.claim || params.argument || 'Dialectic technical argument';
    const evidence = params.evidence || 'Observed runtime and architecture telemetry';
    const argType = (params.argumentType === 'risk' || params.argumentType === 'defense') 
      ? (params.argumentType === 'risk' ? 'con' : 'pro') 
      : params.argumentType;

    const argId = `arg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const argument: AIChallengeArgument = {
      id: argId,
      challengeId: params.challengeId,
      roundNumber: nextRound,
      authorAgent,
      authorRole: params.authorRole,
      argumentType: argType as any,
      claim,
      evidence,
      proposedAlternative: params.proposedAlternative,
      identifiedRisks: params.identifiedRisks || [],
      timestamp: Date.now()
    };
    (argument as any).buildId = buildId;

    db.addChallengeArgument(argument);

    // Update challenge metadata
    challenge.currentRound = nextRound;
    if (!challenge.participants.includes(authorAgent)) {
      challenge.participants.push(authorAgent);
    }
    challenge.updatedAt = Date.now();
    db.saveAIChallenge(challenge);

    return { success: true, argument, challenge };
  }

  /**
   * Concludes a challenge with a formal technical decision and rationale.
   * Automatically persists decision into searchable shared project knowledge.
   */
  static concludeChallenge(
    buildId: string,
    userId: string,
    params: {
      challengeId: string;
      decisionMaker: string;
      decisionMakerRole: AgentRole;
      outcome: AIChallengeOutcome;
      finalDecision: string;
      decisionRationale: string;
    }
  ): { success: boolean; challenge?: AIChallenge; knowledgeItem?: SharedKnowledgeItem; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const challenge = db.getAIChallenge(params.challengeId);
    if (!challenge) {
      return { success: false, error: `Challenge ${params.challengeId} not found` };
    }

    challenge.status = 'concluded';
    challenge.outcome = params.outcome;
    challenge.finalDecision = params.finalDecision;
    challenge.decisionRationale = params.decisionRationale;
    challenge.updatedAt = Date.now();
    db.saveAIChallenge(challenge);

    // Persist as durable SharedKnowledgeItem so decisions are never lost
    const knowledgeId = `know_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const knowledgeItem: SharedKnowledgeItem = {
      id: knowledgeId,
      projectId: buildId,
      buildId,
      sourceAgent: params.decisionMaker,
      sourceRole: params.decisionMakerRole,
      sourceTaskId: challenge.taskId,
      category: 'architecture_decision',
      title: `Challenge Decision: ${challenge.subject} (${params.outcome})`,
      content: `DECISION: ${params.finalDecision}\n\nRATIONALE: ${params.decisionRationale}\n\nORIGINAL PROPOSAL: ${challenge.originalProposal}`,
      relevantFiles: [],
      version: 1,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    db.saveKnowledgeItem(knowledgeItem);

    // Swarm event
    db.addEvent({
      id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      buildId,
      timestamp: Date.now(),
      type: 'ai_challenge_concluded',
      modelId: params.decisionMaker,
      taskId: challenge.taskId,
      details: `AI Challenge [${challenge.subject}] concluded: [${params.outcome.toUpperCase()}]. Decision: "${params.finalDecision.slice(0, 80)}"`
    });

    return { success: true, challenge, knowledgeItem };
  }
}
