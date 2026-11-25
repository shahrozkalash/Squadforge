import express, { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { Build } from '../types.js';
import { validateBuildId } from '../pathSecurity.js';
import { WorkspaceFiles } from './workspaceFiles.js';
import { TerminalService } from './terminalService.js';
import { BuildRunner, type Diagnostic } from './buildRunner.js';
import { GitService } from './gitService.js';
import { PackageService } from './packageService.js';
import { getTemplate, PROJECT_TEMPLATES } from './templates.js';
import { highlightToHtml, languageForPath, tokenize } from './syntaxHighlighter.js';
import { AiAssistService } from './aiAssist.js';
import { IdeProjectGenerator } from './ideProjectGenerator.js';
import { db } from '../store.js';

export interface IdeRouteDependencies {
  requireAuth: express.RequestHandler;
  verifyBuildOwnership: (req: express.Request, res: express.Response, buildId: string) => Build | null | undefined;
}

export function createIdeRouter(deps: IdeRouteDependencies): Router {
  const { requireAuth, verifyBuildOwnership } = deps;
  const router = Router({ mergeParams: true });
  const ai = new AiAssistService();

  const workspaceRootFor = (buildId: string): string => {
    if (!validateBuildId(buildId)) throw new Error('Invalid build id');
    return path.join(process.cwd(), '.ide_workspaces', buildId);
  };

  const owned = (action: (build: Build, req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      const build = verifyBuildOwnership(req, res, req.params.id);
      if (!build) return;
      try {
        await action(build, req, res);
      } catch (err: any) {
        res.status(400).json({ error: err.message || 'IDE operation failed' });
      }
    };

  const services = (buildId: string) => {
    const root = workspaceRootFor(buildId);
    const files = new WorkspaceFiles(root);
    const terminal = new TerminalService(root);
    return {
      files,
      terminal,
      builds: new BuildRunner(terminal),
      git: new GitService(terminal),
      packages: new PackageService(terminal)
    };
  };

  // Generate the desktop IDE application source into the build's files
  router.post('/generate-app', requireAuth, owned(async (build, req, res) => {
    const appName = (req.body?.appName as string) || 'ForgeStudio';
    const config = IdeProjectGenerator.getDefaultConfig(appName);
    const files = IdeProjectGenerator.generateProjectFiles(config);
    for (const [filePath, content] of Object.entries(files)) {
      db.setFile(build.id, { path: filePath, content, version: 1, ownerModel: req.user?.name || 'IDE Swarm' });
    }
    return res.json({ success: true, config, fileCount: Object.keys(files).length, files: Object.keys(files) });
  }));

  router.get('/templates', requireAuth, owned(async (_build, _req, res) =>
    res.json({ templates: PROJECT_TEMPLATES.map(({ id, name, language, description }) => ({ id, name, language, description })) })
  ));

  router.post('/workspace', requireAuth, owned(async (build, req, res) => {
    const { files } = services(build.id);
    const template = getTemplate((req.body?.templateId as string) || 'node');
    files.writeProjectFiles(template.generate((req.body?.appName as string) || 'MyApp'));
    return res.json({ success: true, template: template.id, files: files.listFiles() });
  }));

  router.get('/tree', requireAuth, owned(async (build, _req, res) => {
    const { files } = services(build.id);
    return res.json({ tree: files.tree(), files: files.listFiles() });
  }));

  router.get('/file', requireAuth, owned(async (build, req, res) => {
    const { files } = services(build.id);
    const rel = String(req.query.path ?? '');
    return res.json({ path: rel, content: files.readFile(rel) });
  }));

  router.put('/file', requireAuth, owned(async (build, req, res) => {
    const { files } = services(build.id);
    files.writeFile(String(req.body?.path ?? ''), String(req.body?.content ?? ''));
    return res.json({ success: true });
  }));

  router.delete('/file', requireAuth, owned(async (build, req, res) => {
    const { files } = services(build.id);
    files.deletePath(String(req.query.path ?? ''));
    return res.json({ success: true });
  }));

  router.post('/highlight', requireAuth, owned(async (build, req, res) => {
    const { files } = services(build.id);
    const rel = String(req.body?.path ?? '');
    const content = typeof req.body?.content === 'string' ? req.body.content : files.readFile(rel);
    const language = languageForPath(rel);
    if (!language) return res.json({ language: null, tokens: [], html: '' });
    return res.json({ language, tokens: tokenize(content, language), html: highlightToHtml(content, language) });
  }));

  router.post('/terminal', requireAuth, owned(async (build, req, res) => {
    const { terminal } = services(build.id);
    const result = await terminal.run(String(req.body?.command ?? ''), Array.isArray(req.body?.args) ? req.body.args.map(String) : []);
    return res.json({ result });
  }));

  router.post('/build', requireAuth, owned(async (build, _req, res) => {
    const { builds } = services(build.id);
    return res.json({ outcome: await builds.build() });
  }));

  router.post('/run', requireAuth, owned(async (build, _req, res) => {
    const { builds } = services(build.id);
    return res.json({ result: await builds.runApp() });
  }));

  router.post('/git/:op', requireAuth, owned(async (build, req, res) => {
    const { git } = services(build.id);
    switch (req.params.op) {
      case 'init': await git.init(); return res.json({ success: true });
      case 'status': return res.json({ status: await git.status(), branch: await git.currentBranch().catch(() => '') });
      case 'add': await git.add(Array.isArray(req.body?.paths) ? req.body.paths.map(String) : ['.']); return res.json({ success: true });
      case 'commit': return res.json({ hash: await git.commit(String(req.body?.message ?? 'Update')) });
      case 'log': return res.json({ log: await git.log() });
      case 'diff': return res.json({ diff: await git.diff(Boolean(req.body?.staged)) });
      default: return res.status(404).json({ error: `Unknown git operation: ${req.params.op}` });
    }
  }));

  router.get('/packages', requireAuth, owned(async (build, _req, res) => {
    const { packages } = services(build.id);
    return res.json({ packages: packages.listPackages() });
  }));

  router.post('/packages', requireAuth, owned(async (build, req, res) => {
    const { packages } = services(build.id);
    await packages.addNpmPackage(String(req.body?.name ?? ''), Boolean(req.body?.dev));
    return res.json({ success: true, packages: packages.listPackages() });
  }));

  router.post('/ai/review', requireAuth, owned(async (build, req, res) => {
    const { files } = services(build.id);
    const rel = String(req.body?.path ?? '');
    return res.json({ review: ai.review(rel, files.readFile(rel)) });
  }));

  router.post('/ai/explain', requireAuth, owned(async (_build, req, res) =>
    res.json({ explanation: ai.explain(req.body?.diagnostic as Diagnostic) })
  ));

  router.post('/ai/generate', requireAuth, owned(async (_build, req, res) =>
    res.json({ generation: await ai.generate(String(req.body?.prompt ?? '')) })
  ));

  // Keep fs import used for workspace existence checks in services()
  void fs;

  return router;
}
