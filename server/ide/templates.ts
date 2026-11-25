import { AndroidProjectGenerator } from '../android/androidProjectGenerator.js';

/**
 * Phase 22: project templates for the languages SquadForge supports.
 * Each template is a complete, runnable starter — not a stub: the
 * Node template runs, the Python template runs, the C# template
 * builds with `dotnet build`, the Android template is the genuine
 * Phase 17 generator output.
 */

export interface ProjectTemplate {
  id: string;
  name: string;
  language: string;
  description: string;
  generate(appName: string): Record<string, string>;
}

const sanitize = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '') || 'App';

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'node',
    name: 'Node.js Application',
    language: 'javascript',
    description: 'Plain Node.js app with a start script — runs with `node`.',
    generate(appName) {
      const name = sanitize(appName).toLowerCase();
      return {
        'package.json': JSON.stringify({ name, version: '1.0.0', private: true, type: 'commonjs', scripts: { start: 'node src/index.js', build: 'node --check src/index.js' } }, null, 2),
        'src/index.js': `'use strict';\n\nfunction main() {\n  console.log('Hello from ${appName}!');\n}\n\nmain();\n`,
        'README.md': `# ${appName}\n\nRun with \`npm start\`.\n`
      };
    }
  },
  {
    id: 'typescript',
    name: 'TypeScript Application',
    language: 'typescript',
    description: 'TypeScript app with tsconfig; install TypeScript then build with `npx tsc`.',
    generate(appName) {
      const name = sanitize(appName).toLowerCase();
      return {
        'package.json': JSON.stringify({ name, version: '1.0.0', private: true, scripts: { build: 'tsc', start: 'node dist/index.js' }, devDependencies: { typescript: '^5.5.0' } }, null, 2),
        'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', outDir: 'dist', rootDir: 'src', strict: true }, include: ['src'] }, null, 2),
        'src/index.ts': `function main(): void {\n  const message: string = 'Hello from ${appName}!';\n  console.log(message);\n}\n\nmain();\n`,
        'README.md': `# ${appName}\n\n\`npm install\`, then \`npm run build\` and \`npm start\`.\n`
      };
    }
  },
  {
    id: 'python',
    name: 'Python Application',
    language: 'python',
    description: 'Dependency-free Python app — runs with `python3 main.py`.',
    generate(appName) {
      return {
        'main.py': `"""${appName} entry point."""\n\n\ndef main() -> None:\n    print("Hello from ${appName}!")\n\n\nif __name__ == "__main__":\n    main()\n`,
        'requirements.txt': '# Add dependencies here, one per line.\n',
        'README.md': `# ${appName}\n\nRun with \`python3 main.py\`.\n`
      };
    }
  },
  {
    id: 'csharp-console',
    name: 'C# Console Application',
    language: 'csharp',
    description: '.NET 8 console app — builds with `dotnet build`, runs with `dotnet run`.',
    generate(appName) {
      const asm = sanitize(appName);
      return {
        [`${asm}.csproj`]: `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n</Project>\n`,
        'Program.cs': `Console.WriteLine("Hello from ${appName}!");\n`,
        'README.md': `# ${appName}\n\nBuild with \`dotnet build\`, run with \`dotnet run\`.\n`
      };
    }
  },
  {
    id: 'web',
    name: 'Web Page (HTML/CSS/JS)',
    language: 'html',
    description: 'Static web page with linked stylesheet and script.',
    generate(appName) {
      return {
        'index.html': `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <title>${appName}</title>\n  <link rel="stylesheet" href="styles.css" />\n</head>\n<body>\n  <h1>${appName}</h1>\n  <p id="msg">Loading…</p>\n  <script src="app.js"></script>\n</body>\n</html>\n`,
        'styles.css': `body { font-family: system-ui, sans-serif; margin: 2rem; }\n`,
        'app.js': `document.getElementById('msg').textContent = 'Hello from ${appName}!';\n`
      };
    }
  },
  {
    id: 'android',
    name: 'Android App (Kotlin/Compose)',
    language: 'kotlin',
    description: 'The genuine Phase 17 Android project (Kotlin 2.0, Compose, Gradle 8.7). Build it via the Phase 17 engine.',
    generate(appName) {
      const config = AndroidProjectGenerator.getDefaultConfig(sanitize(appName), `com.squadforge.${sanitize(appName).toLowerCase()}`);
      return AndroidProjectGenerator.generateProjectFiles(config);
    }
  }
];

export function getTemplate(id: string): ProjectTemplate {
  const template = PROJECT_TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`Unknown project template: ${id}`);
  return template;
}
