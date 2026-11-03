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
}

export interface ArchiveStats {
  totalFiles: number;
  totalBytes: number;
  formattedSize: string;
  hasPackageJson: boolean;
  hasReadme: boolean;
  hasEnvExample: boolean;
  categories: {
    source: number;
    config: number;
    documentation: number;
    styles: number;
    tests: number;
    other: number;
  };
}

/**
 * Creates a URL-safe, clean filename slug for the ZIP archive
 */
export function getSanitizedArchiveName(idea?: string): string {
  const base = (idea || 'squadforge-project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
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
 * Calculates file counts, uncompressed byte totals, and category breakdowns
 */
export function calculateArchiveStats(files: ProjectFile[]): ArchiveStats {
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
    totalBytes += new Blob([content]).size;
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

  return {
    totalFiles: files.length,
    totalBytes,
    formattedSize: formatBytes(totalBytes),
    hasPackageJson,
    hasReadme,
    hasEnvExample,
    categories,
  };
}

/**
 * Generates terminal commands to extract, install, and run the project locally
 */
export function formatLocalDevCommands(archiveName: string, files: ProjectFile[]): string {
  const baseName = archiveName.replace(/\.zip$/i, '');
  const hasPackageJson = files.some(f => f.path.toLowerCase().endsWith('package.json'));
  const hasPython = files.some(f => f.path.endsWith('.py'));
  const hasGo = files.some(f => f.path.endsWith('.go'));

  if (hasPackageJson) {
    return `# 1. Extract the downloaded project archive
unzip ${baseName}.zip -d ./${baseName}
cd ./${baseName}

# 2. Copy environment template
cp .env.example .env

# 3. Install dependencies
npm install

# 4. Start local development server
npm run dev`;
  }

  if (hasPython) {
    return `# 1. Extract the downloaded project archive
unzip ${baseName}.zip -d ./${baseName}
cd ./${baseName}

# 2. Setup virtual environment & dependencies
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 3. Run application
python main.py`;
  }

  if (hasGo) {
    return `# 1. Extract the downloaded project archive
unzip ${baseName}.zip -d ./${baseName}
cd ./${baseName}

# 2. Download modules & run
go mod download
go run main.go`;
  }

  return `# 1. Extract the downloaded project archive
unzip ${baseName}.zip -d ./${baseName}
cd ./${baseName}

# 2. Copy environment variables
cp .env.example .env

# 3. Install dependencies & start
npm install
npm run dev`;
}

/**
 * Generates standard .gitignore file content for local development
 */
export function generateGitignore(): string {
  return `# Dependencies
node_modules/
.pnp
.pnp.js

# Environment variables
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# Production build outputs
dist/
build/
out/
.next/

# Logs & runtime
logs/
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# OS and Editor metadata
.DS_Store
Thumbs.db
.vscode/
.idea/
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?
`;
}

/**
 * Generates turnkey Dockerfile and docker-compose.yml files for containerized local development
 */
export function generateDockerConfig(build: Build | null, files: ProjectFile[]): { dockerfile: string; dockerCompose: string } {
  const projectName = getSanitizedArchiveName(build?.idea);
  
  const dockerfile = `# Generated by SquadForge Autonomous Development Swarm
FROM node:22-alpine

WORKDIR /app

# Install dependencies first for layer caching
COPY package*.json ./
RUN npm install

# Copy application source code
COPY . .

# Expose standard local development port
EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=development

CMD ["npm", "run", "dev"]
`;

  const dockerCompose = `version: '3.8'

services:
  ${projectName}:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - NODE_ENV=development
    volumes:
      - .:/app
      - /app/node_modules
    restart: unless-stopped
`;

  return { dockerfile, dockerCompose };
}

/**
 * Generates comprehensive local setup guide (LOCAL_SETUP.md)
 */
export function generateLocalSetupGuide(
  build: Build | null,
  files: ProjectFile[],
  options?: LocalDevExportOptions
): string {
  const projectName = build?.idea || 'SquadForge Project';
  const slug = getSanitizedArchiveName(projectName);
  const techStack = build?.techStack;
  const adrs = build?.architectureDecisions || [];
  const requirements = build?.requirementsChecklist || [];

  return `# ${projectName} - Local Development Guide

Generated by **SquadForge Autonomous Multi-AI Development Swarm** on ${new Date().toLocaleDateString()}.

---

## 🚀 Quick Start (Local Machine)

### Prerequisites
- **Node.js**: v18.0.0 or higher (v20+ or v22 LTS recommended)
- **npm**: v9+ (or **pnpm** / **yarn**)
- **Git** (optional, for version tracking)

### Step 1: Extract & Enter Workspace
\`\`\`bash
unzip ${slug}.zip -d ./${slug}
cd ./${slug}
\`\`\`

### Step 2: Configure Environment Variables
\`\`\`bash
cp .env.example .env
\`\`\`
Edit \`.env\` to fill in any required third-party API keys or local database paths.

### Step 3: Install Dependencies
\`\`\`bash
npm install
\`\`\`

### Step 4: Run Development Server
\`\`\`bash
npm run dev
\`\`\`
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🐳 Optional: Run with Docker

If you prefer containerized local development without installing local Node versions:
\`\`\`bash
docker compose up --build
\`\`\`
Your application will be live at [http://localhost:3000](http://localhost:3000).

---

## 🛠 Project Architecture & Stack

- **Frontend:** ${techStack?.frontend || 'React 19 + TypeScript + Tailwind CSS'}
- **Backend:** ${techStack?.backend || 'Express / Node.js TypeScript API'}
- **Database:** ${techStack?.database || 'SQLite with WAL Mode'}
- **Testing:** ${techStack?.testing || 'Node.js Test Runner (node:test)'}
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
# Run test suite
npm test

# Run TypeScript syntax and lint checks
npm run lint

# Build production bundle
npm run build
\`\`\`

Happy building with SquadForge!
`;
}

/**
 * Builds the complete ZIP Blob in memory using JSZip with all local development assets
 */
export async function buildProjectZipBlob(
  build: Build | null,
  files: ProjectFile[],
  options: LocalDevExportOptions = {}
): Promise<{ blob: Blob; filename: string; fileCount: number }> {
  const {
    archiveName,
    includeSetupGuide = true,
    includeEnvExample = true,
    includeDockerConfig = true,
    includeGitignore = true,
    includeAdrs = true,
    compressionLevel = 6,
  } = options;

  const zip = new JSZip();
  const slug = getSanitizedArchiveName(archiveName || build?.idea);
  const filename = `${slug}.zip`;

  // 1. Add all project source files
  for (const file of files) {
    const cleanPath = file.path.replace(/^\/+/, '');
    if (cleanPath) {
      zip.file(cleanPath, file.content || '');
    }
  }

  // 2. Add README.md if not present or requested
  const hasReadme = files.some(f => f.path.toLowerCase() === 'readme.md');
  if (!hasReadme && includeSetupGuide) {
    zip.file('README.md', generateLocalSetupGuide(build, files, options));
  }

  // 3. Add dedicated LOCAL_SETUP.md for local development clarity
  if (includeSetupGuide) {
    zip.file('LOCAL_SETUP.md', generateLocalSetupGuide(build, files, options));
  }

  // 4. Add .env.example if missing
  const hasEnv = files.some(f => f.path === '.env.example');
  if (!hasEnv && includeEnvExample) {
    zip.file(
      '.env.example',
      `# Environment Variables Template for Local Development\nPORT=3000\nNODE_ENV=development\n`
    );
  }

  // 5. Add .gitignore if missing
  const hasGitignore = files.some(f => f.path === '.gitignore');
  if (!hasGitignore && includeGitignore) {
    zip.file('.gitignore', generateGitignore());
  }

  // 6. Add Docker configs if requested
  const hasDockerfile = files.some(f => f.path.toLowerCase() === 'dockerfile');
  const hasDockerCompose = files.some(f => f.path.toLowerCase() === 'docker-compose.yml');
  if (includeDockerConfig) {
    const { dockerfile, dockerCompose } = generateDockerConfig(build, files);
    if (!hasDockerfile) {
      zip.file('Dockerfile', dockerfile);
    }
    if (!hasDockerCompose) {
      zip.file('docker-compose.yml', dockerCompose);
    }
  }

  // 7. Add Architecture Decisions markdown if requested and available
  if (includeAdrs && build?.architectureDecisions && build.architectureDecisions.length > 0) {
    const adrMarkdown = `# Architecture Decision Records (ADRs)

${build.architectureDecisions.map(a => `## ${a.id}: ${a.title}
- **Status:** ${a.status}
- **Context:** ${a.context}
- **Decision:** ${a.decision}
- **Rationale:** ${a.rationale || 'N/A'}
- **Timestamp:** ${new Date(a.timestamp).toISOString()}
`).join('\n')}
`;
    zip.file('ARCHITECTURE.md', adrMarkdown);
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

  return { blob, filename, fileCount };
}
