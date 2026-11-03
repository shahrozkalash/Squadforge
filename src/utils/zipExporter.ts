import JSZip from 'jszip';
import { Build, ProjectFile } from '../types/index.js';

export interface LocalDevExportOptions {
  archiveName?: string;
  includeSetupGuide?: boolean;
  includeEnvExample?: boolean;
  includeDockerConfig?: boolean;
  includeGitignore?: boolean;
  includeAdrs?: boolean;
  compressionLevel?: number;
  maxFileSizeBytes?: number; // default: 25 MB
  maxTotalSizeBytes?: number; // default: 100 MB
}

export type DetectedStackType = 
  | 'react-vite' 
  | 'nextjs' 
  | 'node-express' 
  | 'python-fastapi' 
  | 'python-django' 
  | 'python-generic' 
  | 'go' 
  | 'static-web' 
  | 'generic';

export interface ProjectStackInfo {
  type: DetectedStackType;
  displayName: string;
  isCertain: boolean;
  port: number;
  devCommand: string;
  installCommand: string;
  buildCommand?: string;
  notes?: string;
}

export interface ExtractedEnvVar {
  name: string;
  description: string;
  defaultValue?: string;
  required: boolean;
  sourceFiles: string[];
}

export interface ArchiveStats {
  totalFiles: number;
  totalBytes: number;
  formattedSize: string;
  hasPackageJson: boolean;
  hasReadme: boolean;
  hasEnvExample: boolean;
  detectedStack: DetectedStackType;
  categories: {
    source: number;
    config: number;
    documentation: number;
    styles: number;
    tests: number;
    other: number;
  };
}

const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const DEFAULT_MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100 MB

/**
 * Validates and normalizes an archive file path.
 * Rejects path traversal (../), absolute paths, Windows drive letters,
 * backslash-based traversal, null bytes, empty paths, and dangerous filenames.
 */
export function validateArchivePath(rawPath: string): { valid: boolean; normalizedPath: string; error?: string } {
  if (typeof rawPath !== 'string') {
    return { valid: false, normalizedPath: '', error: 'Path must be a non-empty string' };
  }

  // 1. Reject null bytes
  if (rawPath.includes('\0')) {
    return { valid: false, normalizedPath: '', error: 'Path contains prohibited null bytes (\\0)' };
  }

  // 2. Reject Windows drive letters (e.g., C:, D:)
  if (/^[a-zA-Z]:/.test(rawPath)) {
    return { valid: false, normalizedPath: '', error: 'Absolute Windows drive letters (e.g. C:) are prohibited in archive entries' };
  }

  // 3. Normalize all backslashes to forward slashes
  const converted = rawPath.replace(/\\/g, '/');

  // 4. Reject absolute root paths (after trimming leading slashes, we'll verify it doesn't escape)
  const trimmed = converted.trim();
  if (!trimmed || trimmed === '.' || trimmed === '/') {
    return { valid: false, normalizedPath: '', error: 'Path cannot be empty or root reference' };
  }

  // 5. Split segments and check traversal
  const segments = trimmed.split('/');
  const normalizedSegments: string[] = [];

  for (const seg of segments) {
    if (!seg || seg === '.') {
      continue; // Skip redundant empty or dot segments
    }
    if (seg === '..') {
      return { valid: false, normalizedPath: '', error: 'Directory traversal (..) is strictly prohibited in archive entries' };
    }
    // Reject Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(seg)) {
      return { valid: false, normalizedPath: '', error: `Reserved device name "${seg}" is prohibited` };
    }
    normalizedSegments.push(seg);
  }

  if (normalizedSegments.length === 0) {
    return { valid: false, normalizedPath: '', error: 'Path resolved to an empty relative path' };
  }

  const normalizedPath = normalizedSegments.join('/');
  return { valid: true, normalizedPath };
}

/**
 * Checks whether a given filename represents an active secret environment file that must never be exported.
 */
export function isSecretEnvFile(cleanPath: string): boolean {
  const filename = cleanPath.split('/').pop()?.toLowerCase() || '';
  if (filename === '.env.example' || filename === '.env.template') {
    return false; // Safe templates are allowed
  }
  return (
    filename === '.env' ||
    filename.startsWith('.env.') ||
    filename.endsWith('.env')
  );
}

/**
 * Creates a URL-safe, clean filename slug for the ZIP archive.
 * Strictly sanitizes against invalid filesystem and URL characters.
 */
export function getSanitizedArchiveName(idea?: string): string {
  const base = (idea || 'squadforge-project')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 50)
    .replace(/^-+|-+$/g, '');
  return base || 'squadforge-project';
}

/**
 * Formats byte counts into human-readable strings (B, KB, MB)
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Detects the actual technology stack of the project by inspecting files, dependencies, and configuration.
 */
export function detectProjectStack(files: ProjectFile[], build?: Build | null): ProjectStackInfo {
  const filePaths = files.map(f => f.path.replace(/^\/+/, '').toLowerCase());
  const pathSet = new Set(filePaths);

  // Find package.json if present
  const packageJsonFile = files.find(f => f.path.replace(/^\/+/, '').toLowerCase() === 'package.json');
  let pkg: any = null;
  if (packageJsonFile && packageJsonFile.content) {
    try {
      pkg = JSON.parse(packageJsonFile.content);
    } catch {}
  }

  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const scripts = pkg?.scripts || {};

  // Check for Next.js
  if (deps['next'] || filePaths.some(p => p.startsWith('next.config.') || p.includes('app/layout.') || p.includes('pages/_app.'))) {
    return {
      type: 'nextjs',
      displayName: 'Next.js (React)',
      isCertain: true,
      port: 3000,
      devCommand: scripts.dev ? 'npm run dev' : 'npx next dev',
      installCommand: 'npm install',
      buildCommand: scripts.build ? 'npm run build' : 'npx next build',
    };
  }

  // Check for React / Vite
  if (deps['vite'] || filePaths.some(p => p.startsWith('vite.config.')) || (deps['react'] && !deps['express'])) {
    return {
      type: 'react-vite',
      displayName: 'React / Vite SPA',
      isCertain: true,
      port: 5173,
      devCommand: scripts.dev ? 'npm run dev' : 'npx vite',
      installCommand: 'npm install',
      buildCommand: scripts.build ? 'npm run build' : 'npx vite build',
    };
  }

  // Check for Node.js / Express
  if (deps['express'] || deps['koa'] || deps['fastify'] || filePaths.some(p => p === 'server.js' || p === 'server.ts' || p === 'src/server.ts')) {
    // Check if express server has a configured port
    let detectedPort = 3000;
    const serverFile = files.find(f => /server\.(ts|js)/i.test(f.path));
    if (serverFile?.content) {
      const match = serverFile.content.match(/PORT\s*=\s*(?:process\.env\.PORT\s*\|\|\s*)?(\d{4,5})/);
      if (match && match[1]) detectedPort = parseInt(match[1], 10);
    }
    return {
      type: 'node-express',
      displayName: 'Node.js / Express Backend',
      isCertain: true,
      port: detectedPort,
      devCommand: scripts.dev ? 'npm run dev' : (scripts.start ? 'npm start' : 'node server.js'),
      installCommand: 'npm install',
      buildCommand: scripts.build ? 'npm run build' : undefined,
    };
  }

  // Check for Python frameworks
  const hasRequirements = pathSet.has('requirements.txt');
  const hasPyproject = pathSet.has('pyproject.toml');
  const pythonFiles = files.filter(f => f.path.endsWith('.py'));
  const hasPython = hasRequirements || hasPyproject || pythonFiles.length > 0;

  if (hasPython) {
    const reqContent = files.find(f => f.path.toLowerCase().endsWith('requirements.txt'))?.content?.toLowerCase() || '';
    const pyContents = pythonFiles.map(f => f.content?.toLowerCase() || '').join('\n');

    // Django
    if (pathSet.has('manage.py') || reqContent.includes('django') || pyContents.includes('django.core')) {
      return {
        type: 'python-django',
        displayName: 'Python (Django)',
        isCertain: true,
        port: 8000,
        devCommand: 'python manage.py runserver 0.0.0.0:8000',
        installCommand: 'pip install -r requirements.txt',
        buildCommand: 'python manage.py migrate',
      };
    }

    // FastAPI
    if (reqContent.includes('fastapi') || pyContents.includes('fastapi') || pyContents.includes('uvicorn')) {
      const mainFile = pathSet.has('main.py') ? 'main' : (pathSet.has('app.py') ? 'app' : 'main');
      return {
        type: 'python-fastapi',
        displayName: 'Python (FastAPI)',
        isCertain: true,
        port: 8000,
        devCommand: `uvicorn ${mainFile}:app --host 0.0.0.0 --port 8000 --reload`,
        installCommand: 'pip install -r requirements.txt',
      };
    }

    // Generic Python
    return {
      type: 'python-generic',
      displayName: 'Python Application',
      isCertain: true,
      port: 8000,
      devCommand: pathSet.has('main.py') ? 'python main.py' : (pathSet.has('app.py') ? 'python app.py' : 'python -m app'),
      installCommand: hasRequirements ? 'pip install -r requirements.txt' : 'pip install -r requirements.txt (if required)',
    };
  }

  // Check for Go
  if (pathSet.has('go.mod') || filePaths.some(p => p.endsWith('.go'))) {
    return {
      type: 'go',
      displayName: 'Go Application',
      isCertain: true,
      port: 8080,
      devCommand: 'go run .',
      installCommand: 'go mod download',
      buildCommand: 'go build -o app .',
    };
  }

  // Static HTML/CSS/JavaScript
  if (pathSet.has('index.html') && !pkg) {
    return {
      type: 'static-web',
      displayName: 'Static HTML/CSS/JS',
      isCertain: true,
      port: 80,
      devCommand: 'npx serve . -p 8080',
      installCommand: '# No installation required for static site',
    };
  }

  // If build metadata specified tech stack
  if (build?.techStack?.frontend && !hasPython) {
    return {
      type: 'react-vite',
      displayName: build.techStack.frontend,
      isCertain: false,
      port: 3000,
      devCommand: 'npm run dev',
      installCommand: 'npm install',
      notes: 'Stack inferred from build metadata. Please verify scripts in package.json.',
    };
  }

  // Uncertain / Generic fallback
  return {
    type: 'generic',
    displayName: 'Standard Web Project',
    isCertain: false,
    port: 3000,
    devCommand: scripts.dev ? 'npm run dev' : 'npm start',
    installCommand: 'npm install',
    notes: 'Stack detection uncertain. Generated a safe generic development configuration.',
  };
}

/**
 * Scans project files for referenced environment variables (process.env, import.meta.env, os.environ, etc.)
 */
export function extractEnvironmentVariables(files: ProjectFile[], build?: Build | null): ExtractedEnvVar[] {
  const envMap = new Map<string, ExtractedEnvVar>();

  // Helper to add or update
  const addVar = (name: string, sourceFile: string, isRequired: boolean = false, desc?: string, defaultVal?: string) => {
    // Ignore internal or system runtime variables
    if (/^(NODE_ENV|PATH|HOME|PWD|SHELL|USER|TERM)$/i.test(name)) return;
    if (!/^[A-Z0-9_]{2,64}$/.test(name)) return;

    const existing = envMap.get(name);
    if (existing) {
      if (!existing.sourceFiles.includes(sourceFile)) {
        existing.sourceFiles.push(sourceFile);
      }
      if (isRequired) existing.required = true;
    } else {
      let description = desc || `Configuration key referenced in ${sourceFile}`;
      if (name.includes('GEMINI')) description = 'Google Gemini API key (obtain from Google AI Studio at https://aistudio.google.com)';
      else if (name.includes('OPENROUTER')) description = 'OpenRouter API key (obtain from https://openrouter.ai)';
      else if (name.includes('OPENAI')) description = 'OpenAI API key (obtain from https://platform.openai.com)';
      else if (name.includes('GITHUB_CLIENT_ID') || name.includes('GITHUB_CLIENT_SECRET')) description = 'GitHub OAuth application credential';
      else if (name.includes('PORT')) description = 'Local HTTP server listening port';
      else if (name.includes('DATABASE') || name.includes('DB_PATH')) description = 'Local database storage path or connection string';
      else if (name.includes('SECRET')) description = 'Cryptographic secret key for session/token encryption';
      else if (name.includes('APP_URL')) description = 'Base URL of the local or deployed application';

      envMap.set(name, {
        name,
        description,
        defaultValue: defaultVal,
        required: isRequired || name.includes('KEY') || name.includes('SECRET'),
        sourceFiles: [sourceFile]
      });
    }
  };

  // 1. Inspect existing .env.example if present in the files
  const existingExample = files.find(f => f.path.toLowerCase().endsWith('.env.example'));
  if (existingExample?.content) {
    const lines = existingExample.content.split('\n');
    let lastComment = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        lastComment = trimmed.replace(/^#+\s*/, '');
        continue;
      }
      if (trimmed.includes('=')) {
        const [k, v] = trimmed.split('=');
        const key = (k || '').trim();
        if (key) {
          addVar(key, '.env.example', false, lastComment || undefined, (v || '').trim());
        }
        lastComment = '';
      }
    }
  }

  // 2. Scan source files using regex
  const jsRegex = /(?:process\.env|import\.meta\.env)\.([A-Z0-9_]{2,64})/g;
  const pyRegex = /(?:os\.environ(?:\.get\(|\[)|os\.getenv\()\s*['"]([A-Z0-9_]{2,64})['"]/g;
  const goRegex = /os\.(?:Getenv|LookupEnv)\s*\(\s*['"]([A-Z0-9_]{2,64})['"]/g;

  for (const file of files) {
    // Never inspect secret files
    if (isSecretEnvFile(file.path)) continue;

    const content = file.content || '';
    let match: RegExpExecArray | null;

    // JavaScript / TypeScript
    while ((match = jsRegex.exec(content)) !== null) {
      addVar(match[1], file.path, true);
    }

    // Python
    while ((match = pyRegex.exec(content)) !== null) {
      addVar(match[1], file.path, true);
    }

    // Go
    while ((match = goRegex.exec(content)) !== null) {
      addVar(match[1], file.path, true);
    }
  }

  return Array.from(envMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Generates an intelligent, documented .env.example content without any real secrets.
 */
export function generateEnvExampleContent(extractedEnvs: ExtractedEnvVar[], existingContent?: string): string {
  const lines: string[] = [
    '# =====================================================================',
    '# SquadForge Local Development Environment Configuration Template',
    '# Copy this file to .env before starting the application: cp .env.example .env',
    '# WARNING: NEVER commit your actual .env file or real secrets to Git!',
    '# =====================================================================',
    ''
  ];

  if (extractedEnvs.length === 0) {
    lines.push(
      '# Standard Local Development Settings',
      'PORT=3000',
      'NODE_ENV=development',
      ''
    );
    return lines.join('\n');
  }

  const required = extractedEnvs.filter(e => e.required);
  const optional = extractedEnvs.filter(e => !e.required);

  if (required.length > 0) {
    lines.push('# --- REQUIRED CONFIGURATION ---');
    for (const v of required) {
      lines.push(`# ${v.description} (Referenced in: ${v.sourceFiles.slice(0, 3).join(', ')})`);
      lines.push(`${v.name}=${v.defaultValue || ''}`);
      lines.push('');
    }
  }

  if (optional.length > 0) {
    lines.push('# --- OPTIONAL / DEFAULT CONFIGURATION ---');
    for (const v of optional) {
      lines.push(`# ${v.description}`);
      lines.push(`${v.name}=${v.defaultValue || ''}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Calculates file counts, uncompressed byte totals, and category breakdowns
 */
export function calculateArchiveStats(files: ProjectFile[], build?: Build | null): ArchiveStats {
  let totalBytes = 0;
  let hasPackageJson = false;
  let hasReadme = false;
  let hasEnvExample = false;

  const categories = {
    source: 0,
    config: 0,
    documentation: 0,
    styles: 0,
    tests: 0,
    other: 0,
  };

  for (const file of files) {
    const content = file.content || '';
    totalBytes += typeof Blob !== 'undefined' ? new Blob([content]).size : Buffer.byteLength(content, 'utf-8');
    const lower = file.path.toLowerCase();

    if (lower.endsWith('package.json')) hasPackageJson = true;
    if (lower.endsWith('readme.md')) hasReadme = true;
    if (lower.endsWith('.env.example')) hasEnvExample = true;

    if (lower.includes('test') || lower.includes('spec')) {
      categories.tests++;
    } else if (lower.endsWith('.css') || lower.endsWith('.scss') || lower.endsWith('.sass')) {
      categories.styles++;
    } else if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.doc')) {
      categories.documentation++;
    } else if (lower.endsWith('.json') || lower.endsWith('.yml') || lower.endsWith('.yaml') || lower.startsWith('.')) {
      categories.config++;
    } else if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.py') || lower.endsWith('.go')) {
      categories.source++;
    } else {
      categories.other++;
    }
  }

  const stackInfo = detectProjectStack(files, build);

  return {
    totalFiles: files.length,
    totalBytes,
    formattedSize: formatBytes(totalBytes),
    hasPackageJson,
    hasReadme,
    hasEnvExample,
    detectedStack: stackInfo.type,
    categories,
  };
}

/**
 * Generates terminal commands to extract, install, and run the project locally
 */
export function formatLocalDevCommands(archiveName: string, files: ProjectFile[], stackInfo?: ProjectStackInfo): string {
  const baseName = archiveName.replace(/\.zip$/i, '');
  const stack = stackInfo || detectProjectStack(files);

  const steps = [
    '# 1. Extract the downloaded project archive',
    `unzip ${baseName}.zip -d ./${baseName}`,
    `cd ./${baseName}`,
    '',
    '# 2. Configure local environment variables',
    'cp .env.example .env',
    ''
  ];

  if (stack.type.startsWith('python')) {
    steps.push(
      '# 3. Setup Python virtual environment & install dependencies',
      'python3 -m venv venv',
      'source venv/bin/activate  # On Windows: .\\venv\\Scripts\\activate',
      stack.installCommand,
      '',
      '# 4. Start local development server',
      stack.devCommand
    );
  } else if (stack.type === 'go') {
    steps.push(
      '# 3. Download Go modules',
      stack.installCommand,
      '',
      '# 4. Run application',
      stack.devCommand
    );
  } else if (stack.type === 'static-web') {
    steps.push(
      '# 3. Serve static site',
      stack.devCommand
    );
  } else {
    // Node.js based
    steps.push(
      '# 3. Install dependencies',
      stack.installCommand,
      '',
      '# 4. Start local development server',
      stack.devCommand
    );
  }

  return steps.join('\n');
}

/**
 * Generates standard .gitignore file content for local development
 */
export function generateGitignore(stackInfo?: ProjectStackInfo): string {
  const lines = [
    '# =====================================================================',
    '# Generated by SquadForge - Project Gitignore',
    '# =====================================================================',
    '',
    '# Environment variables & secrets (CRITICAL: never commit real secrets)',
    '.env',
    '.env.local',
    '.env.development.local',
    '.env.test.local',
    '.env.production.local',
    '*.env',
    '',
    '# Dependencies',
    'node_modules/',
    '.pnp',
    '.pnp.js',
    'vendor/',
    'venv/',
    'env/',
    'ENV/',
    '__pycache__/',
    '*.py[cod]',
    '*$py.class',
    '',
    '# Build artifacts',
    'dist/',
    'build/',
    'out/',
    '.next/',
    'bin/',
    '*.exe',
    '*.dll',
    '*.so',
    '',
    '# Logs and runtime databases',
    '*.log',
    'npm-debug.log*',
    'yarn-debug.log*',
    'yarn-error.log*',
    '*.db',
    '*.sqlite',
    '*.sqlite3',
    '',
    '# Operating System & Editor Metadata',
    '.DS_Store',
    'Thumbs.db',
    '.vscode/',
    '.idea/'
  ];

  return lines.join('\n') + '\n';
}

/**
 * Generates stack-aware turnkey Dockerfile and docker-compose.yml files
 */
export function generateDockerConfig(
  build: Build | null, 
  files: ProjectFile[], 
  stackInfo?: ProjectStackInfo
): { dockerfile: string; dockerCompose: string } {
  const projectName = getSanitizedArchiveName(build?.idea);
  const stack = stackInfo || detectProjectStack(files, build);

  let dockerfile = '';
  let dockerCompose = '';

  if (stack.type === 'react-vite') {
    dockerfile = `# Generated by SquadForge for ${stack.displayName}
FROM node:22-alpine

WORKDIR /app

# Install dependencies first for layer caching
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

EXPOSE ${stack.port}

ENV PORT=${stack.port}
ENV NODE_ENV=development

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "${stack.port}"]
`;
    dockerCompose = `version: '3.8'

services:
  ${projectName}:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "${stack.port}:${stack.port}"
    environment:
      - PORT=${stack.port}
      - NODE_ENV=development
    volumes:
      - .:/app
      - /app/node_modules
    restart: unless-stopped
`;
  } else if (stack.type === 'nextjs') {
    dockerfile = `# Generated by SquadForge for ${stack.displayName}
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE ${stack.port}

ENV PORT=${stack.port}
ENV NODE_ENV=development

CMD ["npm", "run", "dev", "--", "-p", "${stack.port}", "-H", "0.0.0.0"]
`;
    dockerCompose = `version: '3.8'

services:
  ${projectName}:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "${stack.port}:${stack.port}"
    environment:
      - PORT=${stack.port}
      - NODE_ENV=development
    volumes:
      - .:/app
      - /app/node_modules
      - /app/.next
    restart: unless-stopped
`;
  } else if (stack.type === 'python-fastapi') {
    dockerfile = `# Generated by SquadForge for ${stack.displayName}
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*

# Install python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source code
COPY . .

EXPOSE ${stack.port}

ENV PORT=${stack.port}
ENV PYTHONUNBUFFERED=1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "${stack.port}", "--reload"]
`;
    dockerCompose = `version: '3.8'

services:
  ${projectName}:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "${stack.port}:${stack.port}"
    environment:
      - PORT=${stack.port}
      - PYTHONUNBUFFERED=1
    volumes:
      - .:/app
    restart: unless-stopped
`;
  } else if (stack.type === 'python-django') {
    dockerfile = `# Generated by SquadForge for ${stack.displayName}
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE ${stack.port}

ENV PORT=${stack.port}
ENV PYTHONUNBUFFERED=1

CMD ["python", "manage.py", "runserver", "0.0.0.0:${stack.port}"]
`;
    dockerCompose = `version: '3.8'

services:
  ${projectName}:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "${stack.port}:${stack.port}"
    environment:
      - PORT=${stack.port}
      - PYTHONUNBUFFERED=1
    volumes:
      - .:/app
    restart: unless-stopped
`;
  } else if (stack.type === 'python-generic') {
    dockerfile = `# Generated by SquadForge for ${stack.displayName}
FROM python:3.11-slim

WORKDIR /app

COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements.txt || true

COPY . .

ENV PYTHONUNBUFFERED=1

CMD ["python", "main.py"]
`;
    dockerCompose = `version: '3.8'

services:
  ${projectName}:
    build:
      context: .
      dockerfile: Dockerfile
    volumes:
      - .:/app
    restart: unless-stopped
`;
  } else if (stack.type === 'go') {
    dockerfile = `# Generated by SquadForge for ${stack.displayName}
FROM golang:1.22-alpine

WORKDIR /app

COPY go.mod* go.sum* ./
RUN go mod download || true

COPY . .

EXPOSE ${stack.port}

CMD ["go", "run", "."]
`;
    dockerCompose = `version: '3.8'

services:
  ${projectName}:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "${stack.port}:${stack.port}"
    volumes:
      - .:/app
    restart: unless-stopped
`;
  } else if (stack.type === 'static-web') {
    dockerfile = `# Generated by SquadForge for ${stack.displayName}
FROM nginx:alpine

COPY . /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
`;
    dockerCompose = `version: '3.8'

services:
  ${projectName}:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8080:80"
    restart: unless-stopped
`;
  } else {
    // Node / Express or Generic fallback
    dockerfile = `# Generated by SquadForge (${stack.isCertain ? stack.displayName : 'Generic Web Stack'})
FROM node:22-alpine

WORKDIR /app

# Layer dependency installation
COPY package*.json ./
RUN npm install

# Copy application source code
COPY . .

EXPOSE ${stack.port}

ENV PORT=${stack.port}
ENV NODE_ENV=development

CMD ["npm", "run", "dev"]
`;
    dockerCompose = `version: '3.8'

services:
  ${projectName}:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "${stack.port}:${stack.port}"
    environment:
      - PORT=${stack.port}
      - NODE_ENV=development
    volumes:
      - .:/app
      - /app/node_modules
    restart: unless-stopped
`;
  }

  return { dockerfile, dockerCompose };
}

/**
 * Generates comprehensive local setup guide (LOCAL_SETUP.md)
 */
export function generateLocalSetupGuide(
  build: Build | null,
  files: ProjectFile[],
  options?: LocalDevExportOptions,
  stackInfo?: ProjectStackInfo
): string {
  const projectName = build?.idea || 'SquadForge Project';
  const slug = getSanitizedArchiveName(projectName);
  const stack = stackInfo || detectProjectStack(files, build);
  const techStack = build?.techStack;
  const adrs = build?.architectureDecisions || [];
  const requirements = build?.requirementsChecklist || [];

  return `# ${projectName} - Local Development Guide

Generated by **SquadForge Autonomous Multi-AI Development Swarm** on ${new Date().toLocaleDateString()}.
Detected Stack: **${stack.displayName}**${stack.isCertain ? '' : ' (Generic profile)'}

---

## 🚀 Quick Start (Local Machine)

### Prerequisites
${stack.type.startsWith('python') ? '- **Python**: 3.10+ and `pip`' : (stack.type === 'go' ? '- **Go**: 1.21+' : '- **Node.js**: v18.0.0 or higher (v20+ or v22 LTS recommended)\n- **npm**: v9+ (or **pnpm** / **yarn**)')}
- **Git** (for version tracking)
- **Docker & Docker Compose** (optional, for turnkey containerized run)

### Step 1: Extract & Enter Workspace
\`\`\`bash
unzip ${slug}.zip -d ./${slug}
cd ./${slug}
\`\`\`

### Step 2: Configure Environment Variables
\`\`\`bash
cp .env.example .env
\`\`\`
Edit \`.env\` with your text editor. Required API keys are documented with instructions on where to acquire credentials.

### Step 3: Install Dependencies
\`\`\`bash
${stack.installCommand}
\`\`\`

### Step 4: Run Development Server
\`\`\`bash
${stack.devCommand}
\`\`\`
Open [http://localhost:${stack.port}](http://localhost:${stack.port}) in your browser.

---

## 🐳 Containerized Run with Docker

To run the application inside Docker without installing runtime tools locally:
\`\`\`bash
docker compose up --build
\`\`\`
Your application will be live at [http://localhost:${stack.port}](http://localhost:${stack.port}).

---

## 🛠 Project Architecture & Stack

- **Platform:** ${stack.displayName}
- **Frontend:** ${techStack?.frontend || (stack.type === 'react-vite' ? 'React 19 + TypeScript + Tailwind CSS' : 'Standard Web UI')}
- **Backend:** ${techStack?.backend || (stack.type.startsWith('python') ? 'Python Backend' : 'Node.js Engine')}
- **Database:** ${techStack?.database || 'SQLite Storage'}
- **Testing:** ${techStack?.testing || 'Automated Test Runner'}
- **Security:** ${techStack?.security || 'Defensive Input Sanitization & Secret Isolation'}

### Workspace Structure
\`\`\`
${files.slice(0, 25).map(f => `├── ${f.path.replace(/^\/+/, '')}`).join('\n')}${files.length > 25 ? '\n└── ... and ' + (files.length - 25) + ' more files' : ''}
\`\`\`

---

${adrs.length > 0 ? `## 📋 Architecture Decisions (ADRs)
${adrs.map(adr => `### ${adr.id}: ${adr.title}
- **Status:** ${adr.status.toUpperCase()}
- **Context:** ${adr.context}
- **Decision:** ${adr.decision}
${adr.rationale ? `- **Rationale:** ${adr.rationale}` : ''}
`).join('\n')}
---
` : ''}

${requirements.length > 0 ? `## ✅ Requirements Specification
${requirements.map(req => `- [${(req.status === 'verified' || req.status === 'implemented' || req.satisfied) ? 'x' : ' '}] **${req.title || req.id}**: ${req.description} (${req.priority || 'standard'})`).join('\n')}

---
` : ''}

## 🧪 Verification & Automated Tests
\`\`\`bash
${stack.type.startsWith('python') ? 'pytest' : (stack.type === 'go' ? 'go test ./...' : 'npm test')}
\`\`\`

Happy building with SquadForge!
`;
}

/**
 * Builds the complete ZIP Blob in memory using JSZip with strict path validation,
 * resource limits, stack detection, environment variable intelligence, and safe file inclusion.
 */
export async function buildProjectZipBlob(
  build: Build | null,
  files: ProjectFile[],
  options: LocalDevExportOptions = {}
): Promise<{ blob: Blob; filename: string; fileCount: number; stack: DetectedStackType }> {
  const {
    archiveName,
    includeSetupGuide = true,
    includeEnvExample = true,
    includeDockerConfig = true,
    includeGitignore = true,
    includeAdrs = true,
    compressionLevel = 6,
    maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE,
    maxTotalSizeBytes = DEFAULT_MAX_TOTAL_SIZE,
  } = options;

  if (!files || files.length === 0) {
    throw new Error('Cannot export empty project: No project files found in workspace.');
  }

  const zip = new JSZip();
  const slug = getSanitizedArchiveName(archiveName || build?.idea);
  const filename = `${slug}.zip`;

  // Track unique paths and detect collisions
  const seenPaths = new Set<string>();
  const seenLowerMap = new Map<string, string>();
  let totalBytes = 0;

  // 1. Process and validate all project source files
  for (const file of files) {
    // A. Validate path security
    const validation = validateArchivePath(file.path);
    if (!validation.valid) {
      throw new Error(`Security rejection in project file "${file.path}": ${validation.error}`);
    }
    const cleanPath = validation.normalizedPath;

    // B. Security: Strictly exclude secret environment files from being exported
    if (isSecretEnvFile(cleanPath)) {
      console.warn(`[SECURITY] Skipping secret environment file "${cleanPath}" from ZIP export`);
      continue;
    }

    // C. Collision and duplicate detection
    const lower = cleanPath.toLowerCase();
    if (seenPaths.has(cleanPath)) {
      throw new Error(`Duplicate file path detected in export: "${cleanPath}" appears more than once`);
    }
    if (seenLowerMap.has(lower)) {
      const existing = seenLowerMap.get(lower);
      throw new Error(`Path collision detected: "${cleanPath}" collides with existing entry "${existing}" (case conflict)`);
    }

    // D. Validate file size
    const content = file.content || '';
    const byteLength = typeof Blob !== 'undefined' ? new Blob([content]).size : Buffer.byteLength(content, 'utf-8');
    if (byteLength > maxFileSizeBytes) {
      throw new Error(`File "${cleanPath}" (${formatBytes(byteLength)}) exceeds maximum permitted file size (${formatBytes(maxFileSizeBytes)})`);
    }
    totalBytes += byteLength;
    if (totalBytes > maxTotalSizeBytes) {
      throw new Error(`Total export size (${formatBytes(totalBytes)}) exceeds maximum archive size limit (${formatBytes(maxTotalSizeBytes)})`);
    }

    seenPaths.add(cleanPath);
    seenLowerMap.set(lower, cleanPath);
    zip.file(cleanPath, content);
  }

  // Detect project stack for accurate configuration generation
  const stackInfo = detectProjectStack(files, build);

  // Helper to add generated files safely WITHOUT overwriting user-created files
  const addGeneratedFile = (pathName: string, content: string) => {
    const lower = pathName.toLowerCase();
    if (!seenLowerMap.has(lower)) {
      seenPaths.add(pathName);
      seenLowerMap.set(lower, pathName);
      zip.file(pathName, content);
    }
  };

  // 2. Add README.md if not present
  if (includeSetupGuide && !seenLowerMap.has('readme.md')) {
    addGeneratedFile('README.md', generateLocalSetupGuide(build, files, options, stackInfo));
  }

  // 3. Add dedicated LOCAL_SETUP.md for local development clarity if not present
  if (includeSetupGuide && !seenLowerMap.has('local_setup.md')) {
    addGeneratedFile('LOCAL_SETUP.md', generateLocalSetupGuide(build, files, options, stackInfo));
  }

  // 4. Add intelligent .env.example if missing
  if (includeEnvExample && !seenLowerMap.has('.env.example')) {
    const extractedEnvs = extractEnvironmentVariables(files, build);
    const envExample = generateEnvExampleContent(extractedEnvs);
    addGeneratedFile('.env.example', envExample);
  }

  // 5. Add .gitignore if missing
  if (includeGitignore && !seenLowerMap.has('.gitignore')) {
    addGeneratedFile('.gitignore', generateGitignore(stackInfo));
  }

  // 6. Add stack-aware Docker configs if requested and missing
  if (includeDockerConfig) {
    const { dockerfile, dockerCompose } = generateDockerConfig(build, files, stackInfo);
    if (!seenLowerMap.has('dockerfile')) {
      addGeneratedFile('Dockerfile', dockerfile);
    }
    if (!seenLowerMap.has('docker-compose.yml') && !seenLowerMap.has('docker-compose.yaml')) {
      addGeneratedFile('docker-compose.yml', dockerCompose);
    }
  }

  // 7. Add Architecture Decisions markdown if requested and available
  if (includeAdrs && build?.architectureDecisions && build.architectureDecisions.length > 0 && !seenLowerMap.has('architecture.md')) {
    const adrMarkdown = `# Architecture Decision Records (ADRs)

${build.architectureDecisions.map(a => `## ${a.id}: ${a.title}
- **Status:** ${a.status}
- **Context:** ${a.context}
- **Decision:** ${a.decision}
- **Rationale:** ${a.rationale || 'N/A'}
- **Timestamp:** ${new Date(a.timestamp).toISOString()}
`).join('\n')}
`;
    addGeneratedFile('ARCHITECTURE.md', adrMarkdown);
  }

  // Count non-directory files inside the ZIP
  let fileCount = 0;
  zip.forEach((_relativePath, file) => {
    if (!file.dir) {
      fileCount++;
    }
  });

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: compressionLevel },
  });

  return { blob, filename, fileCount, stack: stackInfo.type };
}
