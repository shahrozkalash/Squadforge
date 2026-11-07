import express, { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { db } from '../store.js';
import { Build } from '../types.js';
import { 
  AndroidProjectConfig, 
  AndroidBuildOptions, 
  AndroidBuildResult, 
  AndroidPermission,
  SENSITIVE_ANDROID_PERMISSIONS 
} from './types.js';
import { AndroidProjectGenerator } from './androidProjectGenerator.js';
import { AndroidBuildPipeline } from './androidBuildPipeline.js';
import { ApkInspector } from './apkInspector.js';
import { AndroidEmulatorService } from './androidEmulatorService.js';
import { ApprovalGateService } from '../swarm/approvalGateService.js';

// In-memory cache for generated artifact buffers (buildId -> filename -> Buffer)
const artifactBufferCache: Map<string, Map<string, Buffer>> = new Map();
const ARTIFACTS_BASE_DIR = path.resolve(process.cwd(), '.android_artifacts');

export function storeArtifactBuffer(buildId: string, filename: string, buffer: Buffer) {
  let buildMap = artifactBufferCache.get(buildId);
  if (!buildMap) {
    buildMap = new Map();
    artifactBufferCache.set(buildId, buildMap);
  }
  buildMap.set(filename, buffer);

  // Also persist to workspace filesystem
  try {
    const dir = path.join(ARTIFACTS_BASE_DIR, buildId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(dir, filename), buffer);

    if (filename.endsWith('.apk')) {
      const mode = filename.includes('release') ? 'release' : 'debug';
      const gradleDir = path.resolve(process.cwd(), 'app', 'build', 'outputs', 'apk', mode);
      if (!fs.existsSync(gradleDir)) {
        fs.mkdirSync(gradleDir, { recursive: true });
      }
      fs.writeFileSync(path.join(gradleDir, filename), buffer);
    }
  } catch (err) {
    console.warn(`[Android] Failed to write artifact to workspace disk: ${err}`);
  }
}

export function getArtifactBuffer(buildId: string, filename: string): Buffer | undefined {
  const inMemory = artifactBufferCache.get(buildId)?.get(filename);
  if (inMemory) return inMemory;

  try {
    // Check .android_artifacts
    const diskPath = path.join(ARTIFACTS_BASE_DIR, buildId, filename);
    if (fs.existsSync(diskPath)) {
      const buf = fs.readFileSync(diskPath);
      let buildMap = artifactBufferCache.get(buildId);
      if (!buildMap) {
        buildMap = new Map();
        artifactBufferCache.set(buildId, buildMap);
      }
      buildMap.set(filename, buf);
      return buf;
    }

    // Check app/build/outputs/apk
    const mode = filename.includes('release') ? 'release' : 'debug';
    const gradlePath = path.resolve(process.cwd(), 'app', 'build', 'outputs', 'apk', mode, filename);
    if (fs.existsSync(gradlePath)) {
      const buf = fs.readFileSync(gradlePath);
      let buildMap = artifactBufferCache.get(buildId);
      if (!buildMap) {
        buildMap = new Map();
        artifactBufferCache.set(buildId, buildMap);
      }
      buildMap.set(filename, buf);
      return buf;
    }
  } catch {
    // Ignore error
  }
  return undefined;
}

export interface AndroidRouteDependencies {
  requireAuth: express.RequestHandler;
  verifyBuildOwnership: (req: express.Request, res: express.Response, buildId: string) => Build | null | undefined;
}

export function createAndroidRouter(deps: AndroidRouteDependencies): Router {
  const { requireAuth, verifyBuildOwnership } = deps;
  const router = Router({ mergeParams: true });
  const emulatorService = AndroidEmulatorService.getInstance();

  function getProjectFilesRecord(buildId: string): Record<string, string> {
    const rawFiles = db.getAllFiles(buildId);
    const result: Record<string, string> = {};
    for (const f of rawFiles) {
      if (!f.isDeleted) {
        result[f.path] = f.content;
      }
    }
    return result;
  }

  function getOrCreateConfig(build: Build): AndroidProjectConfig {
    if (build.androidConfig) {
      return build.androidConfig;
    }
    const cleanName = (build.idea || 'SquadForge')
      .split(' ')
      .slice(0, 3)
      .join('')
      .replace(/[^a-zA-Z0-9]/g, '') || 'SquadForgeApp';
    const pkg = `com.squadforge.${cleanName.toLowerCase()}`;
    const defaultConfig = AndroidProjectGenerator.getDefaultConfig(cleanName, pkg);
    build.androidConfig = defaultConfig;
    db.saveBuild(build);
    return defaultConfig;
  }

  const owned = (action: (build: Build, req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      const build = verifyBuildOwnership(req, res, req.params.id);
      if (!build) return;
      try {
        await action(build, req, res);
      } catch (err: any) {
        res.status(500).json({ error: err.message || 'Android operation failed' });
      }
    };

  // 1. Generate / scaffold Android Kotlin & Jetpack Compose project
  router.post('/generate', requireAuth, owned(async (build, req, res) => {
    const { appName, packageName, permissions, features, theme } = req.body || {};
    const baseConfig = getOrCreateConfig(build);
    const config: AndroidProjectConfig = {
      ...baseConfig,
      appName: appName || baseConfig.appName,
      packageName: packageName || baseConfig.packageName,
      permissions: permissions || baseConfig.permissions,
      features: features || baseConfig.features,
      theme: theme ? { ...baseConfig.theme, ...theme } : baseConfig.theme
    };

    const files = AndroidProjectGenerator.generateProjectFiles(config);
    const now = Date.now();

    for (const [filePath, content] of Object.entries(files)) {
      db.setFile(build.id, {
        path: filePath,
        content,
        version: 1,
        ownerModel: req.user?.name || 'Android Swarm'
      });
    }

    build.androidConfig = config;
    build.projectType = 'android_application';
    db.saveBuild(build);

    db.addEvent({
      id: `evt_${now}_${crypto.randomBytes(3).toString('hex')}`,
      buildId: build.id,
      timestamp: now,
      type: 'file_created',
      modelId: 'android_specialist',
      details: `Generated complete Native Android Kotlin & Jetpack Compose project (${Object.keys(files).length} files)`
    });

    res.json({
      success: true,
      config,
      generatedFilesCount: Object.keys(files).length
    });
  }));

  // 2. Get Android configuration
  router.get('/config', requireAuth, owned((build, _req, res) => {
    const config = getOrCreateConfig(build);
    const files = getProjectFilesRecord(build.id);
    const hasAndroidFiles = Object.keys(files).some(p => p.startsWith('app/') || p.endsWith('.gradle.kts'));

    res.json({
      config,
      isAndroidProject: build.projectType === 'android_application' || hasAndroidFiles,
      filesCount: Object.keys(files).length
    });
  }));

  // 3. Update Android configuration
  router.put('/config', requireAuth, owned((build, req, res) => {
    const newConfig: AndroidProjectConfig = req.body?.config;
    if (!newConfig) {
      return res.status(400).json({ error: 'Missing config payload' });
    }

    const oldPermissions: AndroidPermission[] = build.androidConfig?.permissions || [];
    const addedSensitivePermissions = (newConfig.permissions || []).filter(
      (p: AndroidPermission) => SENSITIVE_ANDROID_PERMISSIONS.includes(p) && !oldPermissions.includes(p)
    );

    if (addedSensitivePermissions.length > 0 && req.user) {
      const approvalReq = ApprovalGateService.requestApproval(build.id, req.user.id, {
        requestingAgent: 'android_specialist',
        requestingRole: 'security_specialist',
        operationType: 'security_sensitive_change',
        riskLevel: 'high',
        explanation: `Android project configuration requests high-privilege Android permissions: ${addedSensitivePermissions.join(', ')}`,
        affectedFiles: ['app/src/main/AndroidManifest.xml'],
        proposedChanges: `Adding permissions: ${addedSensitivePermissions.join(', ')}`
      });

      if (approvalReq.success && approvalReq.request) {
        return res.status(202).json({
          requiresApproval: true,
          approvalRequestId: approvalReq.request.id,
          message: `Adding high-privilege permissions (${addedSensitivePermissions.join(', ')}) requires human authorization.`
        });
      }
    }

    build.androidConfig = newConfig;
    db.saveBuild(build);
    res.json({ success: true, config: newConfig });
  }));

  // 4. Trigger Android Build (APK & AAB)
  router.post('/build', requireAuth, owned(async (build, req, res) => {
    const options: AndroidBuildOptions = req.body || { mode: 'debug', target: 'both' };
    const config = getOrCreateConfig(build);

    if (options.mode === 'release' && req.user) {
      const approvalScope = `release_build_${build.id}`;
      const hasApproval = ApprovalGateService.hasApprovedScope(build.id, 'production_deployment', approvalScope);
      
      if (!hasApproval) {
        const approvalReq = ApprovalGateService.requestApproval(build.id, req.user.id, {
          requestingAgent: 'android_release_specialist',
          requestingRole: 'devops_release_specialist',
          operationType: 'production_deployment',
          riskLevel: 'critical',
          explanation: `Building signed Android Release APK / AAB for production distribution (${config.packageName})`,
          affectedFiles: ['app/build.gradle.kts', 'app/src/main/AndroidManifest.xml'],
          proposedChanges: `Assemble Release APK & App Bundle (v1+v2 signing, ProGuard optimization)`
        });

        if (approvalReq.success && approvalReq.request) {
          return res.status(202).json({
            requiresApproval: true,
            approvalRequestId: approvalReq.request.id,
            message: 'Production release build requires explicit human approval.'
          });
        }
      }
    }

    let projectFiles = getProjectFilesRecord(build.id);
    if (Object.keys(projectFiles).filter(p => p.startsWith('app/') || p.endsWith('.gradle.kts')).length === 0) {
      projectFiles = AndroidProjectGenerator.generateProjectFiles(config);
      const now = Date.now();
      for (const [p, c] of Object.entries(projectFiles)) {
        db.setFile(build.id, {
          path: p,
          content: c,
          version: 1,
          ownerModel: 'Android Swarm'
        });
      }
    }

    const { result, apkBuffer, aabBuffer } = await AndroidBuildPipeline.build(
      build.id,
      config,
      projectFiles,
      options
    );

    if (apkBuffer && result.apkFilename) {
      storeArtifactBuffer(build.id, result.apkFilename, apkBuffer);
    }
    if (aabBuffer && result.aabFilename) {
      storeArtifactBuffer(build.id, result.aabFilename, aabBuffer);
    }

    if (!build.androidBuilds) {
      build.androidBuilds = [];
    }
    build.androidBuilds.unshift(result);
    if (build.androidBuilds.length > 20) {
      build.androidBuilds = build.androidBuilds.slice(0, 20);
    }
    db.saveBuild(build);

    db.addEvent({
      id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      buildId: build.id,
      timestamp: Date.now(),
      type: 'build_completed',
      modelId: 'android_build_engineer',
      details: `Android Build #${result.buildNumber} (${options.mode}) finished with status: ${result.status.toUpperCase()}`
    });

    res.json({
      success: result.status === 'success',
      result
    });
  }));

  // 5. List Android builds
  router.get('/builds', requireAuth, owned((build, _req, res) => {
    res.json({
      builds: build.androidBuilds || []
    });
  }));

  // 6. Download artifact (APK or AAB)
  router.get('/artifacts/:filename', (req: Request, res: Response) => {
    const { id, filename } = req.params;
    const buffer = getArtifactBuffer(id, filename);

    if (!buffer) {
      return res.status(404).json({ error: 'Artifact not found or has expired. Please run a build to regenerate.' });
    }

    const isApk = filename.endsWith('.apk');
    const isAab = filename.endsWith('.aab');
    const contentType = isApk 
      ? 'application/vnd.android.package-archive' 
      : isAab 
      ? 'application/octet-stream' 
      : 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  });

  // 7. Validate that an artifact file exists in the workspace
  router.get('/artifacts/:filename/validate', (req: Request, res: Response) => {
    const { id, filename } = req.params;
    const buffer = getArtifactBuffer(id, filename);

    const mode = filename.includes('release') ? 'release' : 'debug';
    const workspaceRelativePaths = [
      path.join('.android_artifacts', id, filename),
      path.join('app', 'build', 'outputs', 'apk', mode, filename)
    ];

    let foundOnDisk = false;
    let diskLocation = '';
    for (const relPath of workspaceRelativePaths) {
      const fullPath = path.resolve(process.cwd(), relPath);
      if (fs.existsSync(fullPath)) {
        foundOnDisk = true;
        diskLocation = relPath;
        break;
      }
    }

    if (!buffer && !foundOnDisk) {
      return res.status(404).json({
        exists: false,
        filename,
        error: `Generated file "${filename}" does not exist in workspace filesystem or artifact cache.`
      });
    }

    const effectiveBuffer = buffer || (foundOnDisk ? fs.readFileSync(path.resolve(process.cwd(), diskLocation)) : null);
    if (!effectiveBuffer || effectiveBuffer.length === 0) {
      return res.status(400).json({
        exists: false,
        filename,
        error: `Artifact file "${filename}" in workspace is empty or unreadable.`
      });
    }

    const isZip = effectiveBuffer.length >= 4 &&
      effectiveBuffer[0] === 0x50 &&
      effectiveBuffer[1] === 0x4b &&
      effectiveBuffer[2] === 0x03 &&
      effectiveBuffer[3] === 0x04;

    const sha256 = crypto.createHash('sha256').update(effectiveBuffer).digest('hex');

    res.json({
      exists: true,
      isValid: isZip,
      filename,
      sizeBytes: effectiveBuffer.length,
      sha256,
      workspacePath: diskLocation || 'in-memory buffer',
      isZipArchive: isZip
    });
  });

  // 7. Inspect an APK
  router.post('/inspect-apk', requireAuth, owned(async (build, req, res) => {
    const filename = req.body?.filename || build.androidBuilds?.[0]?.apkFilename;
    if (!filename) {
      return res.status(400).json({ error: 'No APK filename provided and no prior builds found.' });
    }

    const buffer = getArtifactBuffer(build.id, filename);
    if (!buffer) {
      return res.status(404).json({ error: `Artifact buffer for ${filename} not found in memory.` });
    }

    const report = await ApkInspector.inspect(buffer, filename);
    res.json({ success: true, report });
  }));

  // 8. Virtual Emulator State
  router.get('/emulator', requireAuth, owned((build, _req, res) => {
    const config = getOrCreateConfig(build);
    const state = emulatorService.getOrCreateState(build.id, config);
    res.json({ state });
  }));

  // 9. Virtual Emulator Action Dispatch
  router.post('/emulator/action', requireAuth, owned((build, req, res) => {
    const config = getOrCreateConfig(build);
    const action = req.body;
    const state = emulatorService.dispatchAction(build.id, action, config);
    res.json({ state });
  }));

  // 10. Export Full Android Studio Compatible ZIP
  router.get('/export-studio', requireAuth, owned(async (build, _req, res) => {
    const config = getOrCreateConfig(build);
    let files = getProjectFilesRecord(build.id);

    if (Object.keys(files).filter(p => p.startsWith('app/') || p.endsWith('.gradle.kts')).length === 0) {
      files = AndroidProjectGenerator.generateProjectFiles(config);
    }

    const zip = new JSZip();
    for (const [filePath, content] of Object.entries(files)) {
      zip.file(filePath, content);
    }

    // Add official Gradle wrapper binary & launcher scripts
    zip.file('gradle/wrapper/gradle-wrapper.jar', AndroidProjectGenerator.getWrapperJarBuffer());
    zip.file('gradlew', AndroidProjectGenerator.getGradlewPosix());
    zip.file('gradlew.bat', AndroidProjectGenerator.getGradlewWindows());

    const studioReadme = `# ${config.appName} - Native Android Studio Project
Generated by SquadForge Multi-AI Parallel Swarm Engineering Platform.

## Architecture
- **Language**: Kotlin ${config.kotlinVersion}
- **UI Framework**: Jetpack Compose with Material3
- **Build System**: Gradle 8.7 with Kotlin DSL (.kts)
- **Minimum SDK**: Android API ${config.minSdk}
- **Target SDK**: Android API ${config.targetSdk}

## Opening in Android Studio
1. Launch Android Studio (Hedgehog, Iguana, Jellyfish, Koala, or Ladybug).
2. Click **Open** and select this unzipped root directory.
3. Allow Gradle sync to complete.
4. Select a connected physical device or Android Virtual Device (AVD).
5. Click **Run 'app'** (Shift + F10).
`;
    zip.file('README.md', studioReadme);

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 }
    });

    const zipName = `${config.appName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-android-studio.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.send(zipBuffer);
  }));

  // 11. Toolchain Status (SDK, ADB, AAPT2, apksigner, bundletool, emulator)
  router.get('/toolchain', requireAuth, (_req, res) => {
    const status = emulatorService.detectToolchain();
    res.json({ success: true, toolchain: status });
  });

  // 12. List Connected Android Devices / Running Emulators
  router.get('/devices', requireAuth, (_req, res) => {
    const devices = emulatorService.listConnectedDevices();
    res.json({ success: true, devices });
  });

  // 13. Start Android Virtual Device (Emulator)
  router.post('/emulator/start', requireAuth, async (req, res) => {
    const { avdName, headless } = req.body || {};
    const result = await emulatorService.startEmulator({ avdName, headless });
    res.status(result.success ? 200 : 400).json(result);
  });

  // 14. Install APK onto connected device / emulator
  router.post('/device/install', requireAuth, owned(async (build, req, res) => {
    const { deviceSerial, filename } = req.body || {};
    const apkFile = filename || build.androidBuilds?.[0]?.apkFilename;
    if (!apkFile) {
      return res.status(400).json({ error: 'No APK specified to install' });
    }

    const apkPath = path.resolve(process.cwd(), '.android_artifacts', build.id, apkFile);
    if (!fs.existsSync(apkPath)) {
      return res.status(404).json({ error: `APK file not found on disk: ${apkFile}` });
    }

    const result = await emulatorService.installApk(apkPath, deviceSerial);
    res.status(result.success ? 200 : 500).json(result);
  }));

  // 15. Launch Application on Device / Emulator
  router.post('/device/launch', requireAuth, owned(async (build, req, res) => {
    const { deviceSerial, packageName, activityName } = req.body || {};
    const config = getOrCreateConfig(build);
    const targetPkg = packageName || config.packageName;
    const targetActivity = activityName || `${config.packageName}.${config.mainActivityName}`;

    const result = await emulatorService.launchApp(targetPkg, targetActivity, deviceSerial);
    res.status(result.success ? 200 : 500).json(result);
  }));

  // 16. Collect Live Logcat
  router.get('/device/logcat', requireAuth, async (req, res) => {
    const deviceSerial = req.query.device as string | undefined;
    const lines = parseInt(req.query.lines as string, 10) || 100;
    const filterTag = req.query.tag as string | undefined;

    const result = await emulatorService.collectLogcat({
      deviceSerial,
      lines: Math.min(lines, 500),
      filterTag
    });

    res.json({ success: true, ...result });
  });

  return router;
}
