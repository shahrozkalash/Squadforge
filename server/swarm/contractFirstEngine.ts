import ts from 'typescript';
import { 
  ProjectFile, 
  ProjectContract, 
  ProjectContractType, 
  ContractField 
} from '../types.js';

export interface ContractValidationResult {
  valid: boolean;
  contract: ProjectContract;
  errors: string[];
  warnings: string[];
}

export class ContractFirstEngine {
  /**
   * Extracts existing contracts (interfaces, type aliases, component props, exported functions, API schemas)
   * from source files using the TypeScript Compiler API.
   */
  static extractContractsFromFiles(files: ProjectFile[]): ProjectContract[] {
    const contracts: ProjectContract[] = [];

    for (const file of files) {
      if (!/\.(ts|tsx|js|jsx)$/.test(file.path)) continue;

      try {
        const sourceFile = ts.createSourceFile(
          file.path,
          file.content,
          ts.ScriptTarget.Latest,
          true
        );

        const visit = (node: ts.Node) => {
          // 1. Interfaces
          if (ts.isInterfaceDeclaration(node)) {
            const name = node.name.text;
            const fields: ContractField[] = [];

            node.members.forEach(member => {
              if (ts.isPropertySignature(member) && member.name) {
                const propName = member.name.getText(sourceFile);
                const propType = member.type ? member.type.getText(sourceFile) : 'any';
                const required = !member.questionToken;
                fields.push({
                  name: propName,
                  type: propType,
                  required
                });
              }
            });

            contracts.push({
              id: `contract_${file.path.replace(/[^a-zA-Z0-9]/g, '_')}_${name}`,
              type: name.endsWith('Props') ? 'component_props' : 'typescript_interface',
              name,
              filePath: file.path,
              signature: node.getText(sourceFile),
              description: `Interface contract defined in ${file.path}`,
              fieldsOrParams: fields
            });
          }

          // 2. Type Aliases
          if (ts.isTypeAliasDeclaration(node)) {
            const name = node.name.text;
            contracts.push({
              id: `contract_${file.path.replace(/[^a-zA-Z0-9]/g, '_')}_${name}`,
              type: 'typescript_interface',
              name,
              filePath: file.path,
              signature: node.getText(sourceFile),
              description: `Type alias defined in ${file.path}`
            });
          }

          // 3. Exported Functions / Service Methods
          if (ts.isFunctionDeclaration(node) && node.name && this.hasExportModifier(node)) {
            const name = node.name.text;
            const params: ContractField[] = [];
            node.parameters.forEach(p => {
              params.push({
                name: p.name.getText(sourceFile),
                type: p.type ? p.type.getText(sourceFile) : 'any',
                required: !p.questionToken && !p.initializer
              });
            });

            const returnType = node.type ? node.type.getText(sourceFile) : 'void';
            contracts.push({
              id: `contract_${file.path.replace(/[^a-zA-Z0-9]/g, '_')}_${name}`,
              type: 'service_interface',
              name,
              filePath: file.path,
              signature: `${name}(${params.map(p => `${p.name}: ${p.type}`).join(', ')}): ${returnType}`,
              description: `Exported function contract in ${file.path}`,
              fieldsOrParams: params,
              returnOrResponseType: returnType
            });
          }

          ts.forEachChild(node, visit);
        };

        visit(sourceFile);
      } catch (err) {
        // Continue gracefully on malformed files
      }
    }

    return contracts;
  }

  /**
   * Synthesizes core contracts required for a given feature and profile prior to generating implementation code.
   */
  static synthesizeInitialContracts(
    featureRequirements: string,
    profileId: string,
    targetFilePaths: string[]
  ): ProjectContract[] {
    const contracts: ProjectContract[] = [];
    const normalizedReq = featureRequirements.toLowerCase();

    // 1. Data model / entity contracts
    const primaryTypeFile = targetFilePaths.find(p => p.includes('types')) || 'src/types/index.ts';

    // Extract potential domain names from prompt
    const domainKeywords = ['user', 'product', 'item', 'order', 'task', 'workflow', 'metric', 'event', 'record'];
    const matchedDomains = domainKeywords.filter(k => normalizedReq.includes(k));
    const domainName = matchedDomains[0] ? matchedDomains[0].charAt(0).toUpperCase() + matchedDomains[0].slice(1) : 'Entity';

    contracts.push({
      id: `synth_model_${domainName}`,
      type: 'typescript_interface',
      name: `${domainName}Item`,
      filePath: primaryTypeFile,
      signature: `export interface ${domainName}Item {\n  id: string;\n  name: string;\n  createdAt: number;\n  status?: string;\n}`,
      description: `Core domain model contract for ${domainName}`,
      fieldsOrParams: [
        { name: 'id', type: 'string', required: true },
        { name: 'name', type: 'string', required: true },
        { name: 'createdAt', type: 'number', required: true },
        { name: 'status', type: 'string', required: false }
      ]
    });

    // 2. Component props contract if target file is a component
    const componentFile = targetFilePaths.find(p => p.endsWith('.tsx') || p.endsWith('.jsx'));
    if (componentFile) {
      const compName = componentFile.split('/').pop()?.replace(/\.(tsx|jsx)$/, '') || 'Component';
      contracts.push({
        id: `synth_props_${compName}`,
        type: 'component_props',
        name: `${compName}Props`,
        filePath: componentFile,
        signature: `export interface ${compName}Props {\n  title?: string;\n  onAction?: () => void;\n  className?: string;\n}`,
        description: `Props contract for UI component ${compName}`,
        fieldsOrParams: [
          { name: 'title', type: 'string', required: false },
          { name: 'onAction', type: '() => void', required: false },
          { name: 'className', type: 'string', required: false }
        ]
      });
    }

    // 3. API Contract if backend/API or profile is rest_api_backend
    if (profileId === 'rest_api_backend' || targetFilePaths.some(p => p.startsWith('server/'))) {
      contracts.push({
        id: `synth_api_${domainName}`,
        type: 'api_schema',
        name: `${domainName}ApiResponse`,
        filePath: 'server/types/api.ts',
        signature: `export interface ${domainName}ApiResponse {\n  success: boolean;\n  data?: ${domainName}Item;\n  error?: string;\n}`,
        description: `API schema contract for ${domainName} endpoint responses`,
        fieldsOrParams: [
          { name: 'success', type: 'boolean', required: true },
          { name: 'data', type: `${domainName}Item`, required: false },
          { name: 'error', type: 'string', required: false }
        ]
      });
    }

    return contracts;
  }

  /**
   * Validates whether generated files adhere to established contracts.
   */
  static validateFilesAgainstContracts(
    files: ProjectFile[],
    contracts: ProjectContract[]
  ): ContractValidationResult[] {
    const results: ContractValidationResult[] = [];
    const filesByPath = new Map<string, ProjectFile>();
    for (const f of files) {
      filesByPath.set(f.path.replace(/^\/+/, ''), f);
    }

    for (const contract of contracts) {
      const cleanTarget = contract.filePath.replace(/^\/+/, '');
      const file = filesByPath.get(cleanTarget);
      const errors: string[] = [];
      const warnings: string[] = [];

      if (!file) {
        // Check if contract was exported in another type file
        const foundElsewhere = files.some(f => f.content.includes(contract.name));
        if (!foundElsewhere) {
          errors.push(`Contract file "${contract.filePath}" defining "${contract.name}" was not generated.`);
        } else {
          warnings.push(`Contract "${contract.name}" was found in an alternate file, not "${contract.filePath}".`);
        }
      } else {
        const content = file.content;

        // Check contract symbol presence
        if (!content.includes(contract.name)) {
          errors.push(`File "${contract.filePath}" is missing expected contract declaration "${contract.name}".`);
        }

        // Check required fields presence
        if (contract.fieldsOrParams) {
          for (const field of contract.fieldsOrParams) {
            if (field.required && !content.includes(field.name)) {
              errors.push(`Contract "${contract.name}" in "${contract.filePath}" is missing required member "${field.name}".`);
            }
          }
        }
      }

      results.push({
        valid: errors.length === 0,
        contract,
        errors,
        warnings
      });
    }

    return results;
  }

  private static hasExportModifier(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : (node as any).modifiers;
    if (!modifiers) return false;
    return (modifiers as readonly ts.Modifier[]).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  }
}
