import ts from 'typescript';
import { 
  ProjectFile, 
  ProjectContext, 
  DiscoveredFileContext, 
  DiscoveredComponent, 
  DiscoveredApiEndpoint, 
  DiscoveredDatabaseModel,
  ProjectContract
} from '../types.js';
import { ContractFirstEngine } from './contractFirstEngine.js';

export class ProjectContextEngine {
  /**
   * Discovers and prioritizes relevant project context for a code generation task or user requirement.
   * Manages token budgets carefully so models receive only high-value context.
   */
  static buildProjectContext(
    targetRequirements: string,
    allFiles: ProjectFile[],
    targetFilePaths: string[] = [],
    maxTokenBudget: number = 3500
  ): ProjectContext {
    const relevantFiles = this.discoverAndRankFiles(targetRequirements, allFiles, targetFilePaths);
    const contracts = ContractFirstEngine.extractContractsFromFiles(allFiles);
    const components = this.detectComponents(allFiles);
    const apiEndpoints = this.detectApiEndpoints(allFiles);
    const databaseModels = this.detectDatabaseModels(allFiles);
    const codingConventions = this.detectCodingConventions(allFiles);
    const dependencies = this.extractDependencies(allFiles);

    // Apply token budget to relevant files snippets
    const budgetedFiles = this.fitIntoTokenBudget(relevantFiles, maxTokenBudget);

    // Estimate total tokens used by the built context
    let totalChars = 0;
    budgetedFiles.forEach(f => totalChars += (f.contentSnippet?.length || 0));
    contracts.forEach(c => totalChars += c.signature.length);
    const tokenUsageEstimate = Math.ceil(totalChars / 3.8);

    return {
      relevantFiles: budgetedFiles,
      establishedContracts: contracts,
      detectedComponents: components,
      apiEndpoints,
      databaseModels,
      codingConventions,
      dependencies,
      tokenUsageEstimate
    };
  }

  /**
   * Identifies and ranks relevant files by scoring based on target paths, keyword overlap,
   * import/export linkages, and architectural significance.
   */
  private static discoverAndRankFiles(
    requirements: string,
    allFiles: ProjectFile[],
    explicitTargetPaths: string[]
  ): DiscoveredFileContext[] {
    const normalizedReq = requirements.toLowerCase();
    const keywords = normalizedReq
      .replace(/[^a-z0-9_]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    const scoredFiles: DiscoveredFileContext[] = [];
    const explicitSet = new Set(explicitTargetPaths.map(p => p.replace(/^\/+/, '')));

    for (const file of allFiles) {
      const cleanPath = file.path.replace(/^\/+/, '');
      let score = 0;
      let reason = 'General context';

      // 1. Explicit target path gets maximum priority
      if (explicitSet.has(cleanPath)) {
        score += 100;
        reason = 'Direct target file to modify/create';
      }

      // 2. Core contract/types files get high priority
      if (cleanPath.includes('types') || cleanPath.endsWith('.d.ts')) {
        score += 40;
        reason = 'Core project types & contract definitions';
      }

      // 3. Root entry files (App.tsx, server.ts, main.tsx)
      if (cleanPath === 'src/App.tsx' || cleanPath === 'server.ts' || cleanPath === 'src/main.tsx') {
        score += 25;
        reason = 'Root application entry point';
      }

      // 4. Keyword match on file path and content
      const pathLower = cleanPath.toLowerCase();
      let matchedKeywords = 0;
      for (const kw of keywords) {
        if (pathLower.includes(kw)) {
          matchedKeywords += 3;
        }
      }

      if (matchedKeywords > 0) {
        score += Math.min(matchedKeywords * 5, 30);
        reason = `Matches requirement keywords in path: ${cleanPath}`;
      }

      // Skip non-code / build artifacts if not relevant
      if (cleanPath.includes('node_modules') || cleanPath.includes('dist/')) {
        continue;
      }

      scoredFiles.push({
        path: file.path,
        reason,
        priority: score,
        byteLength: Buffer.byteLength(file.content || '', 'utf-8'),
        contentSnippet: file.content
      });
    }

    // Sort descending by priority score
    return scoredFiles.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Detects React/UI components and their export status across project files.
   */
  private static detectComponents(files: ProjectFile[]): DiscoveredComponent[] {
    const components: DiscoveredComponent[] = [];

    for (const file of files) {
      if (!/\.(tsx|jsx)$/.test(file.path)) continue;

      const content = file.content;
      // Match function ComponentName or const ComponentName: React.FC
      const compRegex = /(?:export\s+(?:default\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9_]*))/g;
      let match;
      while ((match = compRegex.exec(content)) !== null) {
        const compName = match[1];
        const isExported = match[0].includes('export');
        const hasPropsInterface = content.includes(`${compName}Props`);

        components.push({
          name: compName,
          path: file.path,
          propsContract: hasPropsInterface ? `${compName}Props` : undefined,
          isExported
        });
      }
    }

    return components;
  }

  /**
   * Detects REST API route endpoints defined in server files.
   */
  private static detectApiEndpoints(files: ProjectFile[]): DiscoveredApiEndpoint[] {
    const endpoints: DiscoveredApiEndpoint[] = [];

    for (const file of files) {
      if (!file.path.startsWith('server/')) continue;

      const content = file.content;
      const routeRegex = /(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;
      let match;
      while ((match = routeRegex.exec(content)) !== null) {
        endpoints.push({
          method: match[1].toUpperCase(),
          path: match[2]
        });
      }
    }

    return endpoints;
  }

  /**
   * Detects SQLite/database tables and models in database schema or store files.
   */
  private static detectDatabaseModels(files: ProjectFile[]): DiscoveredDatabaseModel[] {
    const models: DiscoveredDatabaseModel[] = [];

    for (const file of files) {
      if (!file.path.includes('db') && !file.path.includes('store')) continue;

      const content = file.content;
      const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\);/gi;
      let match;
      while ((match = tableRegex.exec(content)) !== null) {
        const tableName = match[1];
        const columnsText = match[2];
        const fields = columnsText
          .split('\n')
          .map(l => l.trim().split(/\s+/)[0])
          .filter(f => f && !f.startsWith('--') && !f.startsWith('PRIMARY') && !f.startsWith('FOREIGN') && !f.startsWith('CHECK'));

        models.push({
          name: tableName,
          fields
        });
      }
    }

    return models;
  }

  /**
   * Detects project coding conventions to ensure generated code blends seamlessly.
   */
  private static detectCodingConventions(files: ProjectFile[]): string[] {
    const conventions: string[] = [];

    const hasTs = files.some(f => f.path.endsWith('.ts') || f.path.endsWith('.tsx'));
    if (hasTs) {
      conventions.push('Strict TypeScript typing with explicit interface/type definitions');
    }

    const hasTailwind = files.some(f => f.content.includes('className=') && f.content.includes('bg-neutral-'));
    if (hasTailwind) {
      conventions.push('Tailwind CSS with dark mode tokens (bg-neutral-950, text-neutral-100, accent amber-400)');
    }

    const hasLucide = files.some(f => f.content.includes('lucide-react'));
    if (hasLucide) {
      conventions.push('Lucide React icons for all visual indicators and actions');
    }

    conventions.push('Default/named ES module imports with .js extension for relative server files');
    conventions.push('Defensive error boundaries and graceful fallback UI');

    return conventions;
  }

  /**
   * Reads dependencies declared in package.json if present in the workspace files.
   */
  private static extractDependencies(files: ProjectFile[]): Record<string, string> {
    const pkgFile = files.find(f => f.path === 'package.json' || f.path === '/package.json');
    if (pkgFile) {
      try {
        const parsed = JSON.parse(pkgFile.content);
        return {
          ...(parsed.dependencies || {}),
          ...(parsed.devDependencies || {})
        };
      } catch {
        // Continue
      }
    }
    return {};
  }

  /**
   * Fits discovered files into token budget by truncating lower priority files if necessary.
   */
  private static fitIntoTokenBudget(
    scoredFiles: DiscoveredFileContext[],
    maxTokens: number
  ): DiscoveredFileContext[] {
    let currentChars = 0;
    const maxChars = maxTokens * 3.8;
    const result: DiscoveredFileContext[] = [];

    for (const file of scoredFiles) {
      const content = file.contentSnippet || '';
      const len = content.length;

      if (currentChars + len <= maxChars) {
        result.push(file);
        currentChars += len;
      } else {
        // If high priority (explicit target or contract), provide a condensed preview
        if (file.priority >= 40) {
          const remainingChars = Math.max(400, Math.floor(maxChars - currentChars));
          result.push({
            ...file,
            contentSnippet: content.slice(0, remainingChars) + '\n// ... [Context truncated for token budget] ...'
          });
          currentChars += remainingChars;
        }
        // Stop adding further files once budget is exhausted
        if (currentChars >= maxChars) {
          break;
        }
      }
    }

    return result;
  }
}
