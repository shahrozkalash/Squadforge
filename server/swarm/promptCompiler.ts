import { 
  ProjectContext, 
  GenerationProfile, 
  ProjectContract, 
  AgentRole 
} from '../types.js';
import { AGENT_SPECS } from '../modelRegistry.js';

export interface CompiledPrompt {
  systemPrompt: string;
  userPrompt: string;
  estimatedTokens: number;
}

export class PromptCompiler {
  /**
   * Compiles requirements, architecture profile, established contracts, and project context
   * into pristine, unambiguous model instructions.
   */
  static compileGenerationPrompt(params: {
    userRequirement: string;
    profile: GenerationProfile;
    context: ProjectContext;
    contracts: ProjectContract[];
    targetFiles: string[];
    passName: string;
    agentRole?: AgentRole;
    diagnosticEvidence?: string;
  }): CompiledPrompt {
    const {
      userRequirement,
      profile,
      context,
      contracts,
      targetFiles,
      passName,
      agentRole = 'fullstack_developer',
      diagnosticEvidence
    } = params;

    const roleSpec = AGENT_SPECS[agentRole];
    const roleTitle = roleSpec ? roleSpec.title : 'Senior Software Engineer';
    const roleResponsibilities = roleSpec ? roleSpec.responsibilities.join('; ') : 'Complete fullstack implementation';

    // 1. System Prompt with strict silent worker rules
    const systemPrompt = `You are an elite, specialized ${roleTitle} in SquadForge.
ROLE RESPONSIBILITIES: ${roleResponsibilities}
GENERATION PROFILE: ${profile.displayName} (${profile.category})

STRICT OUTPUT RULES:
- Output only valid JSON actions inside a single JSON block.
- You NEVER write commentary, explanations, greetings, warnings, or markdown outside the JSON block.
- Never return placeholders, empty functions, or "// implement here" comments.
- Every generated file must be complete, pristine, production-grade source code.
- If creating a file, use action "create_file" with the complete source.
- If modifying an existing file, use action "patch_file" with exact "find" text matching the file content.
- Respect all established contracts, interfaces, exports, and imports.

ALLOWED JSON FORMAT:
{
  "actions": [
    {
      "action": "create_file",
      "path": "src/components/Example.tsx",
      "content": "...",
      "commitMessage": "Implement Example component"
    },
    {
      "action": "patch_file",
      "path": "src/App.tsx",
      "find": "<div>old content</div>",
      "replace": "<div>new content</div>",
      "commitMessage": "Wire Example component into App layout"
    }
  ]
}`;

    // 2. Build structured user prompt sections
    const sections: string[] = [];

    // Current Pass Context
    sections.push(`CURRENT GENERATION PASS: [${passName.toUpperCase()}]`);

    // Original User Requirement
    sections.push(`USER REQUIREMENTS:\n${userRequirement.trim()}`);

    // Profile Architectural Blueprint
    sections.push(`ARCHITECTURAL BLUEPRINT (${profile.displayName}):
- Architecture: ${profile.architectureOverview}
- Coding Conventions: ${profile.codingConventions.join('; ')}
- Validation Rules: ${profile.validationRules.join('; ')}
${profile.platformConstraints.limitationNotice ? `- Note: ${profile.platformConstraints.limitationNotice}` : ''}`);

    // Target Files
    if (targetFiles.length > 0) {
      sections.push(`TARGET FILES TO IMPLEMENT/UPDATE:\n${targetFiles.map(f => `- ${f}`).join('\n')}`);
    }

    // Established Contracts
    if (contracts.length > 0) {
      const contractSummaries = contracts.map(c => `[${c.type.toUpperCase()}] ${c.name} in ${c.filePath}:\n${c.signature}`).join('\n\n');
      sections.push(`ESTABLISHED CONTRACTS (Must strictly satisfy and match these):\n${contractSummaries}`);
    }

    // Diagnostic Evidence for Repair Pass
    if (diagnosticEvidence) {
      sections.push(`ERROR EVIDENCE & DIAGNOSTICS (Target of this repair pass):\n${diagnosticEvidence}`);
    }

    // Relevant Source Code Context
    if (context.relevantFiles.length > 0) {
      const fileContexts = context.relevantFiles
        .map(f => `--- FILE: ${f.path} (Priority: ${f.priority}, Reason: ${f.reason}) ---\n${f.contentSnippet || ''}`)
        .join('\n\n');
      sections.push(`EXISTING PROJECT CONTEXT:\n${fileContexts}`);
    }

    // Detected Components & API Endpoints
    if (context.detectedComponents.length > 0 || context.apiEndpoints.length > 0) {
      const compList = context.detectedComponents.map(c => `${c.name} (${c.path})`).join(', ');
      const apiList = context.apiEndpoints.map(e => `${e.method} ${e.path}`).join(', ');
      sections.push(`PROJECT ECOSYSTEM:
- Existing Components: ${compList || 'None'}
- Existing API Endpoints: ${apiList || 'None'}`);
    }

    const userPrompt = sections.join('\n\n');
    const estimatedTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 3.8);

    return {
      systemPrompt,
      userPrompt,
      estimatedTokens
    };
  }
}
