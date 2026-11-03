import crypto from 'node:crypto';
import { db } from '../store.js';
import { 
  AgentMessage, 
  AgentMessageType, 
  AgentRole, 
  AgentProfile,
  AgentLifecycleState 
} from '../types.js';

export interface MessageFilterOptions {
  messageType?: AgentMessageType;
  sender?: string;
  senderRole?: AgentRole;
  recipient?: string;
  taskId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export class CollaborationManager {
  private static MAX_CONVERSATION_DEPTH = 5; // Prevents infinite back-and-forth loops
  private static DUPLICATE_WINDOW_MS = 15000; // 15 seconds window for exact duplicate suppression
  private static recentMessageFingerprints: Map<string, number> = new Map();

  /**
   * Initializes or refreshes all agent profiles for a build
   */
  static initializeBuildAgents(buildId: string, modelIds: string[]): AgentProfile[] {
    const existing = db.getAgentProfiles(buildId);
    if (existing.length >= 10) {
      return existing;
    }

    const roles: Array<{ role: AgentRole; name: string; modelId: string; capabilities: string[]; permissions: string[] }> = [
      {
        role: 'project_manager',
        name: 'Project Manager (PM)',
        modelId: modelIds[0] || 'gpt-4o',
        capabilities: ['planning', 'milestones', 'delegation', 'coordination'],
        permissions: ['create_task', 'delegate_task', 'manage_milestones', 'request_approval']
      },
      {
        role: 'software_architect',
        name: 'Software Architect',
        modelId: modelIds[1] || 'claude',
        capabilities: ['architecture', 'adr', 'contracts', 'modularity'],
        permissions: ['propose_architecture', 'create_adr', 'review_code', 'challenge_proposal']
      },
      {
        role: 'frontend_developer',
        name: 'Frontend Developer',
        modelId: modelIds[2] || 'llama',
        capabilities: ['react', 'ui', 'tailwind', 'accessibility', 'components'],
        permissions: ['write_code', 'propose_patch', 'request_review']
      },
      {
        role: 'backend_developer',
        name: 'Backend Developer',
        modelId: modelIds[3] || 'mistral',
        capabilities: ['api', 'controllers', 'middleware', 'server_logic'],
        permissions: ['write_code', 'propose_patch', 'request_review']
      },
      {
        role: 'database_specialist',
        name: 'Database Engineer',
        modelId: modelIds[4] || 'nemotron',
        capabilities: ['schemas', 'migrations', 'indexes', 'transactions', 'sql'],
        permissions: ['write_code', 'propose_patch', 'propose_migration', 'request_approval']
      },
      {
        role: 'security_specialist',
        name: 'Security Specialist',
        modelId: modelIds[5] || 'grok',
        capabilities: ['owasp', 'sanitization', 'crypto', 'auth_auditing'],
        permissions: ['audit_security', 'review_code', 'report_defect', 'challenge_proposal']
      },
      {
        role: 'ui_ux_designer',
        name: 'UI/UX Designer',
        modelId: modelIds[6] || 'claude-uiux',
        capabilities: ['design_systems', 'typography', 'accessibility', 'interaction'],
        permissions: ['review_ui', 'propose_patch', 'comment_code']
      },
      {
        role: 'qa_testing_specialist',
        name: 'QA & Testing Specialist',
        modelId: modelIds[7] || 'deepseek',
        capabilities: ['test_suites', 'assertions', 'regression', 'verification'],
        permissions: ['run_tests', 'report_defect', 'review_code', 'verify_resolution']
      },
      {
        role: 'debugging_specialist',
        name: 'Debugging Specialist',
        modelId: modelIds[8] || 'qwen',
        capabilities: ['diagnostics', 'stack_traces', 'root_cause', 'surgical_fixes'],
        permissions: ['investigate_defect', 'propose_patch', 'request_review']
      },
      {
        role: 'integration_specialist',
        name: 'Integration Engineer',
        modelId: modelIds[9] || 'gemini',
        capabilities: ['cross_module', 'conflict_resolution', 'contracts', 'end_to_end'],
        permissions: ['resolve_conflicts', 'apply_merges', 'review_code', 'verify_build']
      },
      {
        role: 'performance_engineer',
        name: 'Performance Engineer',
        modelId: modelIds[10] || 'deepseek-perf',
        capabilities: ['latency', 'bundle_budgets', 'memory_profiling', 'query_plans'],
        permissions: ['audit_performance', 'propose_optimization', 'challenge_proposal']
      },
      {
        role: 'documentation_engineer',
        name: 'Documentation Engineer',
        modelId: modelIds[11] || 'mistral-docs',
        capabilities: ['adrs', 'api_specs', 'developer_guides', 'readme'],
        permissions: ['write_docs', 'propose_patch', 'share_knowledge']
      }
    ];

    const profiles: AgentProfile[] = [];
    const now = Date.now();

    for (const r of roles) {
      const existingProfile = db.getAgentProfile(buildId, r.role);
      if (existingProfile) {
        profiles.push(existingProfile);
      } else {
        const newProf: AgentProfile = {
          id: `agent_${r.role}_${buildId.slice(0, 8)}`,
          buildId,
          role: r.role,
          name: r.name,
          modelId: r.modelId,
          status: 'idle',
          capabilities: r.capabilities,
          responsibilities: [
            `Lead ${r.name} responsibilities for autonomous swarm development`,
            `Collaborate with peer agents through persistent messaging and reviews`
          ],
          assignedTaskIds: [],
          currentTaskId: null,
          workloadScore: 0,
          collaborationPermissions: r.permissions,
          workHistory: [
            {
              timestamp: now,
              action: 'initialized',
              details: `Agent ${r.name} onboarded to build workspace`
            }
          ],
          lastActive: now,
          modelStatus: 'idle'
        };
        db.saveAgentProfile(newProf);
        profiles.push(newProf);
      }
    }

    return profiles;
  }

  /**
   * Sends a persistent, structured message between agents or broadcasts to the workspace.
   * Enforces loop prevention, max response depth, and duplicate suppression.
   */
  static sendMessage(
    buildId: string, 
    userId: string, 
    params: {
      sender: string;
      senderRole: AgentRole;
      recipient?: string;
      messageType: AgentMessageType;
      content: string;
      relatedTaskId?: string;
      relatedFiles?: string[];
      relevantFileVersions?: Record<string, number>;
      structuredMetadata?: Record<string, any>;
      parentMessageId?: string;
    }
  ): { success: boolean; message?: AgentMessage; error?: string } {
    const build = db.getBuild(buildId);
    if (!build) {
      return { success: false, error: 'Build not found' };
    }
    if (build.userId !== userId) {
      return { success: false, error: 'Forbidden: Access denied to build communication' };
    }

    // 1. Calculate thread depth & prevent infinite agent conversation loops
    let depth = 0;
    if (params.parentMessageId) {
      const parent = db.getAgentMessage(params.parentMessageId);
      if (parent) {
        depth = (parent.depth || 0) + 1;
        if (depth > this.MAX_CONVERSATION_DEPTH) {
          return {
            success: false,
            error: `Loop protection: Maximum thread depth of ${this.MAX_CONVERSATION_DEPTH} reached for message ${params.parentMessageId}. Topic must be escalated or resolved.`
          };
        }
      }
    }

    // 2. Duplicate suppression within time window
    const now = Date.now();
    const fingerprint = `${buildId}:${params.senderRole}:${params.recipient || 'broadcast'}:${params.messageType}:${params.content.trim()}`;
    const lastSeen = this.recentMessageFingerprints.get(fingerprint);
    if (lastSeen && (now - lastSeen) < this.DUPLICATE_WINDOW_MS) {
      return {
        success: false,
        error: `Duplicate suppression: Identical message already sent within ${this.DUPLICATE_WINDOW_MS / 1000}s`
      };
    }
    this.recentMessageFingerprints.set(fingerprint, now);

    // Clean old fingerprints
    if (this.recentMessageFingerprints.size > 200) {
      for (const [k, ts] of this.recentMessageFingerprints.entries()) {
        if (now - ts > 60000) {
          this.recentMessageFingerprints.delete(k);
        }
      }
    }

    // 3. Assemble and persist message
    const msgId = `msg_${now}_${crypto.randomBytes(4).toString('hex')}`;
    const message: AgentMessage = {
      id: msgId,
      buildId,
      projectId: buildId,
      sender: params.sender,
      senderRole: params.senderRole,
      recipient: params.recipient || 'broadcast',
      relatedTaskId: params.relatedTaskId,
      relatedFiles: params.relatedFiles || [],
      relevantFileVersions: params.relevantFileVersions,
      messageType: params.messageType,
      content: params.content,
      structuredMetadata: params.structuredMetadata,
      parentMessageId: params.parentMessageId,
      depth,
      timestamp: now,
      processingStatus: 'delivered'
    };

    db.saveAgentMessage(message);

    // Update sender agent activity
    db.updateAgentStatus(
      buildId, 
      params.senderRole, 
      'working', 
      `Sent ${params.messageType}: "${params.content.slice(0, 60)}"`,
      params.relatedTaskId
    );

    // Record Swarm Event
    db.addEvent({
      id: `evt_${now}_${crypto.randomBytes(3).toString('hex')}`,
      buildId,
      timestamp: now,
      type: 'agent_message_sent',
      modelId: params.sender,
      taskId: params.relatedTaskId,
      filePath: params.relatedFiles?.[0],
      details: `[${params.senderRole}] -> [${params.recipient || 'all'}]: ${params.messageType} - "${params.content.slice(0, 80)}"`
    });

    return { success: true, message };
  }

  /**
   * Retrieves messages with pagination, filtering, and authorization guard
   */
  static getMessages(
    buildId: string, 
    userId: string, 
    filter?: MessageFilterOptions
  ): { success: boolean; messages: AgentMessage[]; total: number; error?: string } {
    const build = db.getBuild(buildId);
    if (!build) {
      return { success: false, messages: [], total: 0, error: 'Build not found' };
    }
    if (build.userId !== userId) {
      return { success: false, messages: [], total: 0, error: 'Forbidden: Unauthorized' };
    }

    const result = db.getAgentMessages(buildId, {
      messageType: filter?.messageType,
      sender: filter?.sender || filter?.senderRole,
      taskId: filter?.taskId,
      search: filter?.search,
      limit: filter?.limit || 50,
      offset: filter?.offset || 0
    });

    return { success: true, messages: result.messages, total: result.total };
  }
}
