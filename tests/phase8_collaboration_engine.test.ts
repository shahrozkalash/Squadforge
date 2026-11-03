import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { CollaborationManager } from '../server/swarm/collaborationManager.js';
import { SharedWorkspaceService } from '../server/swarm/sharedWorkspaceService.js';
import { CodeReviewEngine } from '../server/swarm/codeReviewEngine.js';
import { PatchValidationPipeline } from '../server/swarm/patchValidationPipeline.js';
import { AIChallengeEngine } from '../server/swarm/aiChallengeEngine.js';
import { CollaborativeDebuggingEngine } from '../server/swarm/collaborativeDebuggingEngine.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { ProjectMemoryService } from '../server/swarm/projectMemory.js';
import { Task, AgentRole } from '../server/types.js';

describe('Phase 8: Collaborative AI Development System Verification Suite', () => {
  const userA = 'usr_p8_tester_a';
  const userB = 'usr_p8_tester_b';
  const buildIdA = 'bld_p8_collab_a';
  const buildIdB = 'bld_p8_collab_b';

  beforeEach(() => {
    // Register users
    db.createUser({
      id: userA,
      email: 'usera@p8.local',
      name: 'P8 User A',
      githubConnected: false,
      costLimitPerBuild: 10.0,
      enabledModelIds: ['gemini'],
      createdAt: Date.now()
    });

    db.createUser({
      id: userB,
      email: 'userb@p8.local',
      name: 'P8 User B',
      githubConnected: false,
      costLimitPerBuild: 10.0,
      enabledModelIds: ['gemini'],
      createdAt: Date.now()
    });

    // Create builds
    db.saveBuild({
      id: buildIdA,
      userId: userA,
      idea: 'Real-time Autonomous Collaborative Swarm IDE',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 10.0,
      maxDurationSeconds: 600,
      patchesAppliedCount: 0
    });

    db.saveBuild({
      id: buildIdB,
      userId: userB,
      idea: 'Isolated Project for Tenant Isolation Testing',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 10.0,
      maxDurationSeconds: 600,
      patchesAppliedCount: 0
    });

    // Initialize agent squad for Build A and B
    CollaborationManager.initializeBuildAgents(buildIdA, ['gemini-2.5-pro', 'claude-3.7-sonnet']);
    CollaborationManager.initializeBuildAgents(buildIdB, ['gemini-2.5-pro']);
  });

  // 1. Agent Messages Creation & Persistence
  test('1. Agent messages are created and persisted correctly with metadata', () => {
    const res = CollaborationManager.sendMessage(buildIdA, userA, {
      sender: 'agent_software_architect',
      senderRole: 'software_architect',
      recipient: 'backend_developer',
      messageType: 'architecture_decision',
      content: 'Adopt CQRS pattern for state mutations and SQLite WAL mode.',
      relatedFiles: ['server/store.ts', 'server/db/database.ts'],
      structuredMetadata: { priority: 'high', architecturalImpact: 'core' }
    });

    assert.strictEqual(res.success, true);
    assert.ok(res.message);
    assert.strictEqual(res.message.buildId, buildIdA);
    assert.strictEqual(res.message.senderRole, 'software_architect');
    assert.strictEqual(res.message.recipient, 'backend_developer');
    assert.strictEqual(res.message.messageType, 'architecture_decision');
    assert.deepStrictEqual(res.message.relatedFiles, ['server/store.ts', 'server/db/database.ts']);

    const retrieved = CollaborationManager.getMessages(buildIdA, userA);
    assert.strictEqual(retrieved.success, true);
    assert.ok(retrieved.messages.some(m => m.id === res.message!.id));
  });

  // 2. Tenant Isolation
  test('2. Messages cannot be read across builds or by unauthorized users', () => {
    CollaborationManager.sendMessage(buildIdA, userA, {
      sender: 'agent_software_architect',
      senderRole: 'software_architect',
      messageType: 'knowledge_share',
      content: 'Confidential architecture spec for project A.'
    });

    CollaborationManager.sendMessage(buildIdB, userB, {
      sender: 'agent_backend_developer',
      senderRole: 'backend_developer',
      messageType: 'knowledge_share',
      content: 'Isolated secret for project B.'
    });

    const msgsA = CollaborationManager.getMessages(buildIdA, userA);
    const msgsB = CollaborationManager.getMessages(buildIdB, userB);

    assert.ok(msgsA.messages.every(m => m.buildId === buildIdA));
    assert.ok(msgsB.messages.every(m => m.buildId === buildIdB));
    assert.strictEqual(msgsA.messages.some(m => m.content.includes('project B')), false);

    // Cross-tenant access attempt must be rejected
    const crossAccess = CollaborationManager.getMessages(buildIdB, userA);
    assert.strictEqual(crossAccess.success, false);
    assert.match(crossAccess.error || '', /Forbidden/);
  });

  // 3 & 4. Filtering and Search
  test('3 & 4. Message filtering by role/type and full-text search', () => {
    CollaborationManager.sendMessage(buildIdA, userA, {
      sender: 'agent_qa_engineer',
      senderRole: 'qa_engineer',
      messageType: 'test_report',
      content: 'Integration test suite passed with 100% assertions.'
    });

    CollaborationManager.sendMessage(buildIdA, userA, {
      sender: 'agent_security_specialist',
      senderRole: 'security_specialist',
      messageType: 'bug_report',
      content: 'Vulnerability CVE-2026-X detected in dependency parse logic.'
    });

    const qaMsgs = CollaborationManager.getMessages(buildIdA, userA, { messageType: 'test_report' });
    assert.strictEqual(qaMsgs.success, true);
    assert.ok(qaMsgs.messages.length > 0);
    assert.ok(qaMsgs.messages.every(m => m.messageType === 'test_report'));

    const searchResults = CollaborationManager.getMessages(buildIdA, userA, { search: 'CVE-2026-X' });
    assert.strictEqual(searchResults.success, true);
    assert.strictEqual(searchResults.messages.length, 1);
    assert.strictEqual(searchResults.messages[0].senderRole, 'security_specialist');
  });

  // 5. Conversation Depth Limit
  test('5. Conversation depth limits prevent infinite agent loops', () => {
    let parentId: string | undefined = undefined;

    // Create a chain of replies up to max depth (5)
    for (let depth = 0; depth <= 5; depth++) {
      const res = CollaborationManager.sendMessage(buildIdA, userA, {
        sender: depth % 2 === 0 ? 'agent_frontend' : 'agent_backend',
        senderRole: depth % 2 === 0 ? 'frontend_developer' : 'backend_developer',
        messageType: 'task_update',
        content: `Reply message unique token ${Date.now()} at depth ${depth}`,
        parentMessageId: parentId
      });
      assert.strictEqual(res.success, true);
      parentId = res.message!.id;
    }

    // Attempting depth 6 must be blocked
    const overflow = CollaborationManager.sendMessage(buildIdA, userA, {
      sender: 'agent_frontend',
      senderRole: 'frontend_developer',
      messageType: 'task_update',
      content: `Exceeding depth limit message unique token ${Date.now()}`,
      parentMessageId: parentId
    });

    assert.strictEqual(overflow.success, false);
    assert.match(overflow.error || '', /Loop protection: Maximum thread depth of 5 reached/);
  });

  // 6. Duplicate Message Suppression
  test('6. Duplicate messages within short window are detected and suppressed', () => {
    const first = CollaborationManager.sendMessage(buildIdA, userA, {
      sender: 'agent_debugging_specialist',
      senderRole: 'debugging_specialist',
      messageType: 'debugging_request',
      content: 'Identified unique race condition in worker event queue handler.'
    });
    assert.strictEqual(first.success, true);

    // Re-sending identical content within 15 seconds must be suppressed
    const duplicate = CollaborationManager.sendMessage(buildIdA, userA, {
      sender: 'agent_debugging_specialist',
      senderRole: 'debugging_specialist',
      messageType: 'debugging_request',
      content: 'Identified unique race condition in worker event queue handler.'
    });

    assert.strictEqual(duplicate.success, false);
    assert.match(duplicate.error || '', /Duplicate suppression: Identical message already sent/);
  });

  // 7, 8, 9. Shared Workspace Context & Stale Version Detection
  test('7, 8, 9. Shared workspace context bounds files, detects stale versions, and isolates builds', () => {
    // Seed task in Build A
    const task: Task = {
      id: 'tsk_workspace_ctx_test',
      buildId: buildIdA,
      title: 'Develop Reactive State Layer',
      description: 'Implement reactive store with cache invalidation',
      assignedRole: 'frontend_developer',
      status: 'in_progress',
      priority: 2,
      filePaths: ['src/App.tsx'],
      createdAt: Date.now()
    };
    db.addTask(buildIdA, task);

    // Seed file in Build A
    db.createFileAtomic(buildIdA, 'system', {
      action: 'create_file',
      path: 'src/App.tsx',
      content: 'export default function App() { return <div>SquadForge</div>; }'
    });

    const file = db.getFile(buildIdA, 'src/App.tsx');
    assert.ok(file);

    const ctxRes = SharedWorkspaceService.getAgentWorkspaceContext(
      buildIdA,
      userA,
      task.id,
      'frontend_developer',
      { 'src/App.tsx': 0 } // Expected 0, current is 1 (stale!)
    );

    assert.strictEqual(ctxRes.success, true);
    assert.ok(ctxRes.context);
    assert.ok(ctxRes.context.targetFiles.some(f => f.path === 'src/App.tsx'));
    assert.strictEqual(ctxRes.context.versionIntegrity.allFilesCurrent, false);
    assert.ok(ctxRes.context.versionIntegrity.staleFilesDetected.includes('src/App.tsx'));

    // Stale version check helper
    const staleVerification = SharedWorkspaceService.verifyFileVersionCurrent(buildIdA, 'src/App.tsx', 0);
    assert.strictEqual(staleVerification.current, false);
    assert.strictEqual(staleVerification.actualVersion, 1);

    const currentVerification = SharedWorkspaceService.verifyFileVersionCurrent(buildIdA, 'src/App.tsx', 1);
    assert.strictEqual(currentVerification.current, true);
  });

  // 10, 11, 12, 13, 14. Advanced Task Delegation & Workload
  test('10, 11, 12, 13, 14. Task delegation transfers assignment, calculates workload, and records rejection/escalation', () => {
    const task: Task = {
      id: 'tsk_delegation_101',
      buildId: buildIdA,
      title: 'Implement Resilient WebSocket Reconnection Protocol',
      description: 'Add exponential backoff with jitter and heartbeats.',
      assignedRole: 'software_architect',
      status: 'pending',
      priority: 2,
      filePaths: ['src/services/socket.ts'],
      createdAt: Date.now()
    };
    db.addTask(buildIdA, task);

    // 10. Delegate task to backend_developer
    const delegateRes = TaskManager.delegateTask(
      buildIdA,
      task.id,
      'software_architect',
      'backend_developer',
      'Backend developer is specialized in networking protocol resilience.'
    );

    assert.strictEqual(delegateRes.success, true);
    assert.strictEqual(delegateRes.task?.assignedRole, 'backend_developer');

    // 12. Workload check
    const allProfiles = db.getAgentProfiles(buildIdA);
    if (allProfiles.length === 0) {
      CollaborationManager.initializeBuildAgents(buildIdA, ['gemini-2.5-pro', 'claude-3.7-sonnet']);
    }
    const profile = db.getAgentProfile(buildIdA, 'backend_developer');
    assert.ok(profile, `Agent profiles found: ${JSON.stringify(allProfiles.map(p => p.role))}`);
    assert.ok(profile.assignedTaskIds.includes(task.id));
    assert.ok(profile.workloadScore > 0);

    // 13. Task rejection
    const rejectRes = TaskManager.rejectTask(
      buildIdA,
      task.id,
      'backend_developer',
      'High current workload and requires security review first'
    );
    assert.strictEqual(rejectRes.success, true);
    assert.strictEqual(rejectRes.task?.status, 'pending');

    // 14. Task escalation
    const escalateRes = TaskManager.escalateTask(
      buildIdA,
      task.id,
      'backend_developer',
      'Escalating to project manager for architectural redistribution'
    );
    assert.strictEqual(escalateRes.success, true);
    assert.strictEqual(escalateRes.task?.assignedRole, 'project_manager');
    assert.strictEqual(escalateRes.task?.priority, 1);
  });

  // 15, 16, 17, 18, 19. Code Review Engine & Self-Review Block
  test('15, 16. Code review assigns reviewers and strictly blocks self-review', () => {
    const task1: Task = {
      id: 'tsk_1',
      buildId: buildIdA,
      title: 'Auth Migration Task',
      description: 'Migrate tokens to constant-time',
      filePaths: ['server/auth.ts', 'server/api.ts'],
      priority: 2,
      status: 'in_progress',
      createdAt: Date.now()
    };
    db.addTask(buildIdA, task1);

    // 16. Self-review must be blocked
    const selfReview = CodeReviewEngine.submitForReview(buildIdA, userA, {
      taskId: 'tsk_1',
      authorAgent: 'agent_backend_developer',
      authorRole: 'backend_developer',
      reviewerRole: 'backend_developer', // Same role
      changedFiles: ['server/api.ts'],
      baseVersions: { 'server/api.ts': 1 },
      proposedChanges: [{ filePath: 'server/api.ts', action: 'patch' }],
      requirementsAddressed: ['REQ-1'],
      implementationExplanation: 'Self reviewing my own changes',
      testEvidence: 'Self tests'
    });

    // Check that independent reviewer was enforced or self review blocked
    assert.ok(selfReview.review?.reviewerRole !== 'backend_developer');

    // 15. Valid review submission
    const reviewRes = CodeReviewEngine.submitForReview(buildIdA, userA, {
      taskId: 'tsk_1',
      authorAgent: 'agent_backend_developer',
      authorRole: 'backend_developer',
      reviewerRole: 'security_specialist',
      changedFiles: ['server/auth.ts'],
      baseVersions: { 'server/auth.ts': 1 },
      proposedChanges: [{ filePath: 'server/auth.ts', action: 'patch' }],
      requirementsAddressed: ['SEC-101'],
      implementationExplanation: 'Migrated auth session tokens to constant-time comparison.',
      testEvidence: 'Security test suite pass'
    });

    assert.strictEqual(reviewRes.success, true);
    assert.ok(reviewRes.review);
    assert.strictEqual(reviewRes.review.status, 'pending');
    assert.strictEqual(reviewRes.review.reviewerRole, 'security_specialist');
  });

  test('17, 18, 19. Line-level comments and critical comments prevent approval', () => {
    const task2: Task = {
      id: 'tsk_2',
      buildId: buildIdA,
      title: 'Frontend App Rendering',
      description: 'Update App component rendering',
      filePaths: ['src/App.tsx'],
      priority: 2,
      status: 'in_progress',
      createdAt: Date.now()
    };
    db.addTask(buildIdA, task2);

    const reviewRes = CodeReviewEngine.submitForReview(buildIdA, userA, {
      taskId: 'tsk_2',
      authorAgent: 'agent_frontend_developer',
      authorRole: 'frontend_developer',
      reviewerRole: 'qa_engineer',
      changedFiles: ['src/App.tsx'],
      baseVersions: { 'src/App.tsx': 1 },
      proposedChanges: [{ filePath: 'src/App.tsx', action: 'patch' }],
      requirementsAddressed: ['UI-1'],
      implementationExplanation: 'Updated App rendering',
      testEvidence: 'UI snapshot tests'
    });

    assert.strictEqual(reviewRes.success, true, reviewRes.error);
    const reviewId = reviewRes.review!.id;

    // 17. Attach line comment with critical severity
    const commentRes = CodeReviewEngine.addComment(buildIdA, userA, {
      reviewId,
      filePath: 'src/App.tsx',
      startLine: 12,
      endLine: 14,
      severity: 'critical',
      explanation: 'Unsanitized HTML injection via dangerouslySetInnerHTML',
      suggestedCorrection: 'Use textContent or sanitized markup renderer',
      author: 'agent_qa_engineer',
      authorRole: 'qa_engineer'
    });

    assert.strictEqual(commentRes.success, true, commentRes.error);
    assert.ok(commentRes.comment);
    assert.strictEqual(commentRes.comment.severity, 'critical');

    // 19. Critical comment MUST force verdict to changes_requested even if reviewer attempted approval
    const verdictRes = CodeReviewEngine.submitVerdict(buildIdA, userA, {
      reviewId,
      reviewerAgent: 'agent_qa_engineer',
      verdict: 'approved', // Attempting approval
      summaryComments: 'Approving regardless of critical flaw'
    });

    assert.strictEqual(verdictRes.success, true);
    assert.strictEqual(verdictRes.review?.verdict, 'changes_requested');
    assert.strictEqual(verdictRes.review?.status, 'revising');
  });

  // 20, 21, 22, 23, 24, 25. Patch Proposals, Path Traversal, and Conflicts
  test('20, 21. Patch proposal blocks path traversal attacks', () => {
    const invalidPathRes = PatchValidationPipeline.proposePatch(buildIdA, userA, {
      authorAgent: 'agent_backend',
      authorRole: 'backend_developer',
      relatedTaskId: 'tsk_101',
      targetFile: '../../etc/passwd',
      baseFileVersion: 1,
      baseContentHash: 'hash123',
      proposedChanges: { actionType: 'create', content: 'malicious' },
      changeExplanation: 'Malicious path traversal attempt',
      expectedBehavior: 'Fail'
    });

    assert.strictEqual(invalidPathRes.success, false);
    assert.match(invalidPathRes.error || '', /Invalid target path/);
  });

  test('22, 24, 25. Patches against stale base versions trigger conflict detection and safe resolution', async () => {
    const taskCfg: Task = {
      id: 'tsk_cfg',
      buildId: buildIdA,
      title: 'Config Update Task',
      description: 'Update port configuration to 8080',
      filePaths: ['src/config.ts'],
      priority: 2,
      status: 'in_progress',
      createdAt: Date.now()
    };
    db.addTask(buildIdA, taskCfg);

    db.createFileAtomic(buildIdA, 'system', {
      action: 'create_file',
      path: 'src/config.ts',
      content: 'export const PORT = 3000;\nexport const ENV = "production";\n'
    });

    // 22. Propose patch against stale version 0 (current is 1)
    const patchRes = PatchValidationPipeline.proposePatch(buildIdA, userA, {
      authorAgent: 'agent_frontend',
      authorRole: 'frontend_developer',
      relatedTaskId: 'tsk_cfg',
      targetFile: 'src/config.ts',
      baseFileVersion: 0, // Stale!
      baseContentHash: 'hash_old_v0',
      proposedChanges: { actionType: 'patch', find: 'PORT = 3000', replace: 'PORT = 8080' },
      changeExplanation: 'Update port configuration',
      expectedBehavior: 'Switch port'
    });

    assert.strictEqual(patchRes.success, false);
    assert.ok(patchRes.conflict);
    assert.strictEqual(patchRes.conflict.resolutionStatus, 'open');
    assert.strictEqual(patchRes.conflict.filePath, 'src/config.ts');

    // 25. Resolve conflict
    const resolveRes = await PatchValidationPipeline.resolveConflict(buildIdA, userA, {
      conflictId: patchRes.conflict.id,
      resolvedBy: 'agent_backend_developer',
      resolvedContent: 'export const PORT = 8080;\nexport const ENV = "production";\n',
      resolutionExplanation: 'Adopted PORT 8080 and preserved production ENV.'
    });

    assert.strictEqual(resolveRes.success, true);
    assert.ok(resolveRes.resolvedVersion);

    // Verify file content was safely updated in database
    const updatedFile = db.getFile(buildIdA, 'src/config.ts');
    assert.ok(updatedFile);
    assert.ok(updatedFile.content.includes('PORT = 8080'));
  });

  // 26, 27, 28. AI Challenge Mode & Dialectic Debate Limits
  test('26, 27, 28. AI challenge multi-round debate produces structured arguments and persists knowledge', () => {
    // 26. Start challenge
    const startRes = AIChallengeEngine.startChallenge(buildIdA, userA, {
      subject: 'database_design',
      originalProposal: 'Store all JSON telemetry in a single unindexed TEXT column.',
      proposerAgent: 'agent_backend',
      proposerRole: 'backend_developer',
      challengerRole: 'database_engineer'
    });

    assert.strictEqual(startRes.success, true);
    const challenge = startRes.challenge!;
    assert.strictEqual(challenge.currentRound, 1);
    assert.strictEqual(challenge.outcome, 'pending');

    // Add arguments
    AIChallengeEngine.addArgument(buildIdA, userA, {
      challengeId: challenge.id,
      agentRole: 'database_engineer',
      round: 1,
      argumentType: 'risk',
      argument: 'Unindexed JSON causes sequential table scans on 10M records.',
      evidence: 'Benchmark shows 2500ms response vs 4ms with indexes.'
    });

    AIChallengeEngine.addArgument(buildIdA, userA, {
      challengeId: challenge.id,
      agentRole: 'backend_developer',
      round: 2,
      argumentType: 'defense',
      argument: 'Schema is dynamic and evolves rapidly across telemetry models.'
    });

    AIChallengeEngine.addArgument(buildIdA, userA, {
      challengeId: challenge.id,
      agentRole: 'database_engineer',
      round: 3,
      argumentType: 'risk',
      argument: 'SQLite supports JSON extract expressions in indexes without strict DDL changes.'
    });

    // 27. Max 3 rounds limit: round 4 must be blocked
    const overflowArg = AIChallengeEngine.addArgument(buildIdA, userA, {
      challengeId: challenge.id,
      agentRole: 'backend_developer',
      round: 4,
      argumentType: 'defense',
      argument: 'Exceeding round limit argument'
    });

    assert.strictEqual(overflowArg.success, false);
    assert.match(overflowArg.error || '', /Cannot exceed maximum of 3 debate rounds/);

    // 28. Conclude challenge and persist knowledge
    const concludeRes = AIChallengeEngine.concludeChallenge(buildIdA, userA, {
      challengeId: challenge.id,
      outcome: 'accepted_with_changes',
      finalDecision: 'Use SQLite JSON extract functional index for telemetry queries.',
      decisionRationale: 'Preserves dynamic JSON flexibility while securing indexed sub-millisecond query performance.',
      decidedByRole: 'software_architect'
    });

    assert.strictEqual(concludeRes.success, true);
    assert.strictEqual(concludeRes.challenge?.outcome, 'accepted_with_changes');

    // Verify knowledge persistence
    const knowledge = ProjectMemoryService.searchKnowledge(buildIdA, userA, { search: 'telemetry queries' });
    assert.ok(knowledge.length > 0);
    assert.ok(knowledge.some(k => k.category === 'adr'));
  });

  // 29, 30. Collaborative Defect Tracking & Honesty Verification Guard
  test('29, 30. Defect investigations record root causes and honesty guard prevents resolving without evidence', () => {
    // 29. Report defect
    const reportRes = CollaborativeDebuggingEngine.recordDefect(buildIdA, userA, {
      title: 'Memory leak in streaming SSE listener connection loop',
      description: 'EventSource reconnects continuously without cleanup on unmount.',
      severity: 'high',
      reproductionSteps: ['Mount SwarmLive view', 'Navigate to Code view', 'Check open connections'],
      expectedBehavior: 'EventSource closed cleanly on component unmount.',
      actualBehavior: '10 dangling EventSources established.',
      affectedFiles: ['src/context/SwarmContext.tsx']
    });

    assert.strictEqual(reportRes.success, true);
    const defect = reportRes.defect!;
    assert.strictEqual(defect.status, 'open');

    // Add root cause hypothesis and solution
    const solRes = CollaborativeDebuggingEngine.proposeSolution(buildIdA, userA, {
      defectId: defect.id,
      authorRole: 'debugging_specialist',
      rootCauseHypothesis: 'Missing sse.close() invocation in useEffect cleanup return callback.',
      proposedDiff: 'return () => { sse.close(); clearInterval(pollInterval); };',
      estimatedImpact: 'Stops memory leak and stabilizes browser connection quota.'
    });

    assert.strictEqual(solRes.success, true);

    // 30. Honesty Guard: Cannot mark resolved without verification evidence
    const unresolvedWithoutEvidence = CollaborativeDebuggingEngine.updateStatus(
      buildIdA,
      userA,
      {
        defectId: defect.id,
        status: 'resolved'
        // Missing verificationEvidence and testEvidence
      }
    );

    assert.strictEqual(unresolvedWithoutEvidence.success, false);
    assert.match(unresolvedWithoutEvidence.error || '', /Cannot mark defect resolved without execution and test verification evidence/);

    // Mark resolved with valid verification evidence
    const resolvedWithEvidence = CollaborativeDebuggingEngine.updateStatus(
      buildIdA,
      userA,
      {
        defectId: defect.id,
        status: 'resolved',
        verificationEvidence: {
          syntaxPassed: true,
          testsPassed: true,
          evidenceText: 'Verified with automated browser unmount test: connection count returned to baseline 0.'
        }
      }
    );

    assert.strictEqual(resolvedWithEvidence.success, true);
    assert.strictEqual(resolvedWithEvidence.defect?.status, 'resolved');
    assert.ok(resolvedWithEvidence.defect?.verificationDetails);
  });

  // 31, 32, 33. Human Approval Gates & Self-Approval Prevention
  test('31, 32, 33. Approval requests block restricted operations and prevent agent self-approval', () => {
    // 31. Check operation requires approval
    const isRestricted = ApprovalGateService.requiresApproval('destructive_file_op', 1);
    assert.strictEqual(isRestricted, true);

    // Create approval request
    const reqRes = ApprovalGateService.requestApproval(buildIdA, userA, {
      requestingAgent: 'agent_database_engineer',
      requestingRole: 'database_engineer',
      operationType: 'destructive_file_op',
      affectedFiles: ['server/db/schema.sql'],
      explanation: 'Purge deprecated tables for SQLite migration cleanup.',
      proposedChanges: 'DROP TABLE deprecated_logs;',
      riskLevel: 'critical'
    });

    assert.strictEqual(reqRes.success, true);
    const req = reqRes.request!;
    assert.strictEqual(req.status, 'pending');

    // 32. Agent cannot self-approve restricted operation!
    const selfApprove = ApprovalGateService.respondToApproval(buildIdA, userA, {
      requestId: req.id,
      approved: true,
      approvedBy: 'agent_database_engineer', // Agent trying to approve!
      resolutionNotes: 'Self approved by agent'
    });

    assert.strictEqual(selfApprove.success, false);
    assert.match(selfApprove.error || '', /Agents cannot approve their own restricted operations/);

    // Human approves operation
    const humanApprove = ApprovalGateService.respondToApproval(buildIdA, userA, {
      requestId: req.id,
      approved: true,
      approvedBy: userA, // Human user ID
      resolutionNotes: 'Reviewed schema migration and verified table backup exists.'
    });

    assert.strictEqual(humanApprove.success, true);
    assert.strictEqual(humanApprove.request?.status, 'approved');
  });

  // 34, 35. Shared Knowledge Persistence & Superseding History
  test('34, 35. Shared knowledge persists, remains searchable, and preserves history when superseded', () => {
    // 34. Record knowledge item
    const recordRes = ProjectMemoryService.recordKnowledgeItem(buildIdA, userA, {
      sourceAgent: 'agent_software_architect',
      sourceRole: 'software_architect',
      category: 'pattern',
      title: 'State Sync Protocol v1',
      content: 'Use periodic HTTP polling at 5 second intervals.',
      relevantFiles: ['src/services/sync.ts']
    });

    assert.strictEqual(recordRes.success, true);
    const original = recordRes.item!;
    assert.ok(original.id);
    assert.strictEqual(original.status, 'active');

    // 35. Supersede with v2
    const supersedeRes = ProjectMemoryService.supersedeKnowledgeItem(
      buildIdA,
      userA,
      {
        targetId: original.id,
        sourceAgent: 'agent_software_architect',
        sourceRole: 'software_architect',
        newTitle: 'State Sync Protocol v2',
        newContent: 'Upgrade from polling to Server-Sent Events (SSE) with exponential fallback.',
        supersedeReason: 'Lower server CPU overhead and achieve sub-second latency'
      }
    );

    assert.strictEqual(supersedeRes.success, true);
    const superseded = supersedeRes.newItem!;
    assert.ok(superseded.id);
    assert.strictEqual(superseded.status, 'active');

    // Check original now has superseded status in database
    const allItems = ProjectMemoryService.searchKnowledge(buildIdA, userA, { search: 'Protocol', status: 'superseded' });
    const oldItem = allItems.find(k => k.id === original.id);
    assert.ok(oldItem);
    assert.strictEqual(oldItem.status, 'superseded');
    assert.strictEqual(oldItem.supersedeReason, 'Lower server CPU overhead and achieve sub-second latency');
  });

  // 36. Comprehensive Multi-Tenant & Cross-Build Isolation Audit
  test('36. Cross-build isolation rejects unauthorized reading and mutation across all collaboration services', async () => {
    // Setup resources in Build B (owned by userB)
    db.addTask(buildIdB, {
      id: 'tsk_b_1',
      buildId: buildIdB,
      title: 'Task in Build B',
      description: 'Implement server logic for B',
      status: 'pending',
      priority: 2,
      filePaths: ['server.ts'],
      createdAt: Date.now()
    });

    const reviewB = CodeReviewEngine.submitForReview(buildIdB, userB, {
      taskId: 'tsk_b_1',
      authorAgent: 'agent_author_b',
      authorRole: 'backend_developer',
      reviewerRole: 'security_specialist',
      changedFiles: ['server.ts'],
      baseVersions: { 'server.ts': 1 },
      proposedChanges: [{ filePath: 'server.ts', action: 'patch' }],
      requirementsAddressed: ['Auth hardening'],
      implementationExplanation: 'Hardened cookie parser options',
      testEvidence: 'Unit tests passed for session validation'
    });
    assert.strictEqual(reviewB.success, true);
    const revIdB = reviewB.review!.id;

    const patchB = PatchValidationPipeline.proposePatch(buildIdB, userB, {
      authorAgent: 'agent_author_b',
      authorRole: 'backend_developer',
      relatedTaskId: 'tsk_b_1',
      targetFile: 'server.ts',
      baseFileVersion: 1,
      baseContentHash: 'hash_b_1',
      proposedChanges: { actionType: 'create', content: 'const b = 1;' },
      changeExplanation: 'Create server entry',
      expectedBehavior: 'Server boots cleanly'
    });
    const patchIdB = patchB.patch!.id;

    const challengeB = AIChallengeEngine.startChallenge(buildIdB, userB, {
      subject: 'Architecture',
      originalProposal: 'Use distributed event bus',
      proposerAgent: 'agent_architect_b',
      proposerRole: 'software_architect'
    });
    const challengeIdB = challengeB.challenge!.id;

    const defectB = CollaborativeDebuggingEngine.recordDefect(buildIdB, userB, {
      title: 'Private defect in project B',
      description: 'Leak in B socket pool',
      severity: 'high',
      reproductionSteps: ['step 1'],
      expectedBehavior: 'Clean pool',
      actualBehavior: 'Dangling socket',
      affectedFiles: ['socket_b.ts']
    });
    const defectIdB = defectB.defect!.id;

    const approvalB = ApprovalGateService.requestApproval(buildIdB, userB, {
      requestingAgent: 'agent_b',
      requestingRole: 'database_engineer',
      operationType: 'destructive_file_op',
      affectedFiles: ['data_b.sql'],
      explanation: 'Delete obsolete table in B',
      proposedChanges: 'DROP TABLE b_temp;'
    });
    const approvalIdB = approvalB.request!.id;

    const knowledgeB = ProjectMemoryService.recordKnowledgeItem(buildIdB, userB, {
      sourceAgent: 'agent_b',
      sourceRole: 'software_architect',
      category: 'adr',
      title: 'Confidential Algorithm in B',
      content: 'Proprietary sorting mechanism',
      relevantFiles: ['algo_b.ts']
    });
    const knowledgeIdB = knowledgeB.item!.id;

    const msgB = CollaborationManager.sendMessage(buildIdB, userB, {
      sender: 'agent_b',
      senderRole: 'software_architect',
      messageType: 'architecture_decision',
      content: 'Classified message in build B'
    });
    const msgIdB = msgB.message!.id;

    // ATTACK 1: User A attempts to add comment to Build B's review using Build A
    const addCommentAttack = CodeReviewEngine.addComment(buildIdA, userA, {
      reviewId: revIdB, // ID from Build B
      filePath: 'server.ts',
      startLine: 1,
      endLine: 5,
      severity: 'critical',
      explanation: 'Cross-build injection attempt',
      author: 'agent_attacker',
      authorRole: 'security_specialist'
    });
    assert.strictEqual(addCommentAttack.success, false);
    assert.match(addCommentAttack.error || '', /not found in this build/);

    // ATTACK 2: User A attempts to submit verdict on Build B's review using Build A
    const submitVerdictAttack = CodeReviewEngine.submitVerdict(buildIdA, userA, {
      reviewId: revIdB,
      reviewerAgent: 'attacker',
      verdict: 'approved'
    });
    assert.strictEqual(submitVerdictAttack.success, false);
    assert.match(submitVerdictAttack.error || '', /not found in this build/);

    // ATTACK 3: User A attempts to apply Build B's patch in Build A
    const applyPatchAttack = await PatchValidationPipeline.applyApprovedPatch(buildIdA, userA, patchIdB);
    assert.strictEqual(applyPatchAttack.success, false);
    assert.match(applyPatchAttack.error || '', /not found in this build/);

    // ATTACK 4: User A attempts to add argument to Build B's challenge using Build A
    const addArgAttack = AIChallengeEngine.addArgument(buildIdA, userA, {
      challengeId: challengeIdB,
      authorRole: 'backend_developer',
      argumentType: 'risk',
      argument: 'Injected counter-argument'
    });
    assert.strictEqual(addArgAttack.success, false);
    assert.match(addArgAttack.error || '', /not found in this build/);

    // ATTACK 5: User A attempts to conclude Build B's challenge using Build A
    const concludeAttack = AIChallengeEngine.concludeChallenge(buildIdA, userA, {
      challengeId: challengeIdB,
      outcome: 'rejected',
      finalDecision: 'Malicious conclusion',
      decisionRationale: 'Unauthorized decision'
    });
    assert.strictEqual(concludeAttack.success, false);
    assert.match(concludeAttack.error || '', /not found in this build/);

    // ATTACK 6: User A attempts to propose solution on Build B's defect using Build A
    const solAttack = CollaborativeDebuggingEngine.proposeSolution(buildIdA, userA, {
      defectId: defectIdB,
      proposal: 'Malicious solution'
    });
    assert.strictEqual(solAttack.success, false);
    assert.match(solAttack.error || '', /not found in this build/);

    // ATTACK 7: User A attempts to update status of Build B's defect using Build A
    const statusAttack = CollaborativeDebuggingEngine.updateStatus(buildIdA, userA, {
      defectId: defectIdB,
      status: 'resolved',
      testEvidence: 'Fake evidence'
    });
    assert.strictEqual(statusAttack.success, false);
    assert.match(statusAttack.error || '', /not found in this build/);

    // ATTACK 8: User A attempts to approve Build B's approval request using Build A
    const approveAttack = ApprovalGateService.respondToApproval(buildIdA, userA, {
      requestId: approvalIdB,
      approved: true,
      approvedBy: userA
    });
    assert.strictEqual(approveAttack.success, false);
    assert.match(approveAttack.error || '', /not found in this build/);

    // ATTACK 9: User A attempts to supersede Build B's knowledge item using Build A
    const supersedeAttack = ProjectMemoryService.supersedeKnowledgeItem(buildIdA, userA, {
      targetId: knowledgeIdB,
      sourceAgent: 'agent_attacker',
      sourceRole: 'software_architect',
      newContent: 'Tampered knowledge',
      supersedeReason: 'Unauthorized modification'
    });
    assert.strictEqual(supersedeAttack.success, false);
    assert.match(supersedeAttack.error || '', /not found in this build/);

    // ATTACK 10: User A attempts to reply to Build B's parent message using Build A
    const msgAttack = CollaborationManager.sendMessage(buildIdA, userA, {
      sender: 'attacker',
      senderRole: 'software_architect',
      messageType: 'task_update',
      content: 'Tampered reply',
      parentMessageId: msgIdB
    });
    assert.strictEqual(msgAttack.success, false);
    assert.match(msgAttack.error || '', /not found in this build/);
  });
});
