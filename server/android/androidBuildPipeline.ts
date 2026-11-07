import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { 
  AndroidProjectConfig, 
  AndroidBuildOptions, 
  AndroidBuildResult, 
  AndroidBuildLogEntry, 
  AndroidDiagnostic 
} from './types.js';
import { ApkInspector } from './apkInspector.js';
import { AndroidProjectGenerator } from './androidProjectGenerator.js';

import {
  assertSafeWorkspacePath,
  sanitizeWorkspacePath,
  assertScopedArtifactPath,
  validateArtifactScope
} from '../pathSecurity.js';

export { assertSafeWorkspacePath, sanitizeWorkspacePath };

export class AndroidBuildPipeline {
  private static buildCounter = 1;

  /**
   * Helper to spawn a Gradle process with cross-platform support and live streaming output.
   * Handles Windows (cmd.exe /c gradlew.bat) and POSIX (sh gradlew or direct executable).
   */
  public static async runGradleProcess(
    gradlewBin: string,
    tasks: string[],
    workspaceDir: string,
    env: NodeJS.ProcessEnv,
    addLog?: (level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', step: string, message: string) => void
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      let command: string;
      let args: string[];

      if (process.platform === 'win32') {
        command = 'cmd.exe';
        args = ['/c', gradlewBin, ...tasks];
      } else {
        try {
          fs.chmodSync(gradlewBin, 0o755);
        } catch {
          // ignore
        }
        command = '/bin/sh';
        args = [gradlewBin, ...tasks];
      }

      const proc = spawn(command, args, {
        cwd: workspaceDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      proc.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        if (addLog) {
          const lines = text.split('\n').filter((l: string) => l.trim().length > 0);
          for (const line of lines) {
            const level = line.includes('FAILED') || line.includes('ERROR') ? 'ERROR'
              : line.includes('WARNING') || line.includes('w:') ? 'WARN'
              : 'INFO';
            addLog(level, 'GRADLE', line.trim());
          }
        }
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        if (addLog) {
          const lines = text.split('\n').filter((l: string) => l.trim().length > 0);
          for (const line of lines) {
            addLog('WARN', 'GRADLE_ERR', line.trim());
          }
        }
      });

      proc.on('close', (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });

      proc.on('error', (err) => {
        stderr += err.message;
        if (addLog) {
          addLog('ERROR', 'GRADLE_EXEC', `Failed to spawn Gradle wrapper: ${err.message}`);
        }
        resolve({ exitCode: 1, stdout, stderr });
      });
    });
  }

  /**
   * Runs arbitrary Gradle tasks in a given workspace directory using genuine Gradle execution
   */
  public static async runGradleTasks(
    workspaceDir: string,
    tasks: string[]
  ): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
    const sdkPath = AndroidProjectGenerator.detectSdkLocation();
    const javaHome = AndroidProjectGenerator.detectJavaHome();

    if (!sdkPath || !javaHome) {
      return {
        success: false,
        stdout: '',
        stderr: `Toolchain missing: sdkPath=${sdkPath || 'NOT_FOUND'}, javaHome=${javaHome || 'NOT_FOUND'}`,
        exitCode: 127
      };
    }

    const gradlewBin = process.platform === 'win32'
      ? path.join(workspaceDir, 'gradlew.bat')
      : path.join(workspaceDir, 'gradlew');

    const pathEntries = [
      path.join(sdkPath, 'platform-tools'),
      path.join(sdkPath, 'cmdline-tools', 'latest', 'bin'),
      path.join(sdkPath, 'build-tools', '34.0.0'),
      path.join(javaHome, 'bin'),
      process.env.PATH
    ].filter(Boolean) as string[];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAVA_HOME: javaHome,
      ANDROID_HOME: sdkPath,
      ANDROID_SDK_ROOT: sdkPath,
      PATH: pathEntries.join(path.delimiter)
    };

    const res = await this.runGradleProcess(gradlewBin, tasks, workspaceDir, env);
    return {
      success: res.exitCode === 0,
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode
    };
  }

  /**
   * Executes the genuine Android build pipeline exclusively via Gradle.
   * Synthetic DEX, resource, signing, and packaging methods are completely excluded.
   */
  public static async build(
    buildId: string,
    config: AndroidProjectConfig,
    projectFiles: Record<string, string>,
    options: AndroidBuildOptions = { mode: 'debug', target: 'both' }
  ): Promise<{
    result: AndroidBuildResult;
    apkBuffer?: Buffer;
    aabBuffer?: Buffer;
  }> {
    const startTime = Date.now();
    const buildNum = this.buildCounter++;
    const logs: AndroidBuildLogEntry[] = [];
    const diagnostics: AndroidDiagnostic[] = [];

    const addLog = (level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', step: string, message: string) => {
      logs.push({ timestamp: Date.now(), level, step, message });
    };

    addLog('INFO', 'INIT', `Starting Genuine Native Android Gradle Build #${buildNum} in ${options.mode} mode for ${config.packageName}`);
    addLog('INFO', 'CONFIG', `Target compileSdk=${config.compileSdk}, targetSdk=${config.targetSdk}, minSdk=${config.minSdk}, Kotlin=${config.kotlinVersion}, AGP=${config.agpVersion}`);

    // Check permissions
    if (config.permissions.length === 0) {
      addLog('WARN', 'PERMISSIONS', 'No permissions specified in configuration.');
      diagnostics.push({
        severity: 'warning',
        file: 'AndroidManifest.xml',
        message: 'No permissions declared in AndroidManifest.xml.',
        suggestion: 'Add required permissions (e.g., android.permission.INTERNET).'
      });
    } else {
      addLog('INFO', 'PERMISSIONS', `Validated ${config.permissions.length} declared permissions: ${config.permissions.join(', ')}`);
    }

    // Step 1: Verify Gradle wrapper assets before proceeding
    const wrapperCheck = AndroidProjectGenerator.verifyWrapperAssets();
    if (!wrapperCheck.valid) {
      addLog('ERROR', 'WRAPPER', `Gradle wrapper assets check failed: ${wrapperCheck.errors.join('; ')}`);
      diagnostics.push({
        severity: 'error',
        file: 'gradle/wrapper/gradle-wrapper.jar',
        message: `Gradle wrapper assets verification failed: ${wrapperCheck.errors.join('; ')}`
      });

      const failedResult: AndroidBuildResult = {
        id: `abuild_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        buildId,
        buildNumber: buildNum,
        timestamp: Date.now(),
        status: 'failed',
        mode: options.mode,
        target: options.target,
        logs,
        diagnostics,
        durationMs: Date.now() - startTime,
        error: `Gradle wrapper assets verification failed: ${wrapperCheck.errors.join('; ')}`
      };
      return { result: failedResult };
    }

    // Step 2: Establish isolated workspace and write files with strict path validation
    const workspaceDir = path.resolve(process.cwd(), '.android_workspaces', buildId);
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }
    addLog('INFO', 'PREPARE', `Materializing Android project in isolated workspace: ${workspaceDir}`);

    try {
      for (const [rawRelPath, content] of Object.entries(projectFiles)) {
        const fullPath = assertSafeWorkspacePath(workspaceDir, rawRelPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf-8');
      }
    } catch (secErr: any) {
      addLog('ERROR', 'SECURITY', `Workspace path validation failed: ${secErr.message}`);
      diagnostics.push({
        severity: 'error',
        file: 'workspace',
        message: secErr.message
      });

      const failedResult: AndroidBuildResult = {
        id: `abuild_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        buildId,
        buildNumber: buildNum,
        timestamp: Date.now(),
        status: 'failed',
        mode: options.mode,
        target: options.target,
        logs,
        diagnostics,
        durationMs: Date.now() - startTime,
        error: `Workspace security rejection: ${secErr.message}`
      };
      return { result: failedResult };
    }

    // Step 3: Materialize official Gradle wrapper assets into workspace
    addLog('INFO', 'WRAPPER', 'Installing official Gradle wrapper and launcher scripts into workspace...');
    const wrapperDir = path.join(workspaceDir, 'gradle', 'wrapper');
    fs.mkdirSync(wrapperDir, { recursive: true });
    fs.writeFileSync(path.join(wrapperDir, 'gradle-wrapper.jar'), AndroidProjectGenerator.getWrapperJarBuffer());

    const wrapperPropsPath = path.join(wrapperDir, 'gradle-wrapper.properties');
    if (!fs.existsSync(wrapperPropsPath)) {
      fs.writeFileSync(
        wrapperPropsPath,
        'distributionBase=GRADLE_USER_HOME\n' +
        'distributionPath=wrapper/dists\n' +
        'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.7-bin.zip\n' +
        'networkTimeout=10000\n' +
        'validateDistributionUrl=true\n' +
        'zipStoreBase=GRADLE_USER_HOME\n' +
        'zipStorePath=wrapper/dists\n',
        'utf-8'
      );
    }

    const gradlewPosix = path.join(workspaceDir, 'gradlew');
    fs.writeFileSync(gradlewPosix, AndroidProjectGenerator.getGradlewPosix(), 'utf-8');
    try {
      fs.chmodSync(gradlewPosix, 0o755);
    } catch {
      // Ignored on platforms without POSIX permissions
    }

    const gradlewWindows = path.join(workspaceDir, 'gradlew.bat');
    fs.writeFileSync(gradlewWindows, AndroidProjectGenerator.getGradlewWindows(), 'utf-8');

    // Ensure gradle.properties exists
    const gradlePropsPath = path.join(workspaceDir, 'gradle.properties');
    if (!fs.existsSync(gradlePropsPath)) {
      fs.writeFileSync(
        gradlePropsPath,
        'org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8\n' +
        'android.useAndroidX=true\n' +
        'android.nonTransitiveRClass=true\n' +
        'kotlin.code.style=official\n',
        'utf-8'
      );
    }

    // Step 4: Validate Java & JAVA_HOME (without hardcoded paths)
    const javaHome = AndroidProjectGenerator.detectJavaHome();
    if (!javaHome) {
      addLog('ERROR', 'TOOLCHAIN', 'Java Development Kit (JDK 17+) not detected in environment. Checked JAVA_HOME, PATH, and standard system paths.');
      diagnostics.push({
        severity: 'error',
        file: 'build.gradle.kts',
        message: 'JDK 17+ is strictly required to execute Gradle builds, but was not detected in environment. Set JAVA_HOME or install Java 17+.'
      });

      const failedResult: AndroidBuildResult = {
        id: `abuild_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        buildId,
        buildNumber: buildNum,
        timestamp: Date.now(),
        status: 'failed',
        mode: options.mode,
        target: options.target,
        logs,
        diagnostics,
        durationMs: Date.now() - startTime,
        error: 'Java Development Kit (JDK 17+) not detected in environment'
      };
      return { result: failedResult };
    }
    addLog('INFO', 'TOOLCHAIN', `Configured validated JAVA_HOME: ${javaHome}`);

    // Step 5: Validate Android SDK location (without hardcoded paths)
    const sdkPath = AndroidProjectGenerator.detectSdkLocation();
    if (!sdkPath) {
      addLog('ERROR', 'TOOLCHAIN', 'No Android SDK installation detected in environment (checked ANDROID_HOME, ANDROID_SDK_ROOT, and system paths).');
      diagnostics.push({
        severity: 'error',
        file: 'local.properties',
        message: 'Android SDK not detected. Configure ANDROID_HOME or ANDROID_SDK_ROOT.'
      });

      const failedResult: AndroidBuildResult = {
        id: `abuild_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        buildId,
        buildNumber: buildNum,
        timestamp: Date.now(),
        status: 'failed',
        mode: options.mode,
        target: options.target,
        logs,
        diagnostics,
        durationMs: Date.now() - startTime,
        error: 'Android SDK not detected in environment'
      };
      return { result: failedResult };
    }

    addLog('INFO', 'TOOLCHAIN', `Configured Android SDK location: ${sdkPath}`);
    fs.writeFileSync(path.join(workspaceDir, 'local.properties'), `sdk.dir=${sdkPath.replace(/\\/g, '/')}\n`, 'utf-8');

    // Step 6: Determine Gradle tasks
    const modeUpper = options.mode === 'release' ? 'Release' : 'Debug';
    const gradleTasks: string[] = [];
    if (options.target === 'apk') {
      gradleTasks.push(`assemble${modeUpper}`);
    } else if (options.target === 'aab') {
      gradleTasks.push(`bundle${modeUpper}`);
    } else {
      gradleTasks.push(`assemble${modeUpper}`, `bundle${modeUpper}`);
    }

    if (options.runTests) {
      gradleTasks.push(`test${modeUpper}UnitTest`);
    }
    if (options.lintCheck) {
      gradleTasks.push(`lint${modeUpper}`);
    }

    // Step 7: Cross-platform environment configuration
    const pathEntries = [
      path.join(sdkPath, 'platform-tools'),
      path.join(sdkPath, 'cmdline-tools', 'latest', 'bin'),
      path.join(sdkPath, 'build-tools', '34.0.0'),
      path.join(javaHome, 'bin'),
      process.env.PATH
    ].filter(Boolean) as string[];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAVA_HOME: javaHome,
      ANDROID_HOME: sdkPath,
      ANDROID_SDK_ROOT: sdkPath,
      PATH: pathEntries.join(path.delimiter)
    };

    const gradlewBin = process.platform === 'win32' ? gradlewWindows : gradlewPosix;
    addLog('INFO', 'GRADLE', `Executing Gradle tasks: ./gradlew ${gradleTasks.join(' ')}`);

    const gradleResult = await this.runGradleProcess(gradlewBin, gradleTasks, workspaceDir, env, addLog);

    if (gradleResult.exitCode !== 0) {
      addLog('ERROR', 'GRADLE', `Gradle execution failed with exit code ${gradleResult.exitCode}`);
      const errLines = gradleResult.stderr.split('\n').concat(gradleResult.stdout.split('\n'))
        .filter(l => l.includes('e:') || l.includes('FAILURE:') || l.includes('FAILED') || l.includes('Exception:'));
      for (const el of errLines.slice(0, 5)) {
        diagnostics.push({
          severity: 'error',
          file: 'gradle',
          message: el.trim()
        });
      }

      const durationMs = Date.now() - startTime;
      const failedResult: AndroidBuildResult = {
        id: `abuild_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        buildId,
        buildNumber: buildNum,
        timestamp: Date.now(),
        status: 'failed',
        mode: options.mode,
        target: options.target,
        logs,
        diagnostics,
        durationMs,
        error: `Gradle build failed with exit code ${gradleResult.exitCode}: ${errLines[0] || 'Unknown build failure'}`
      };
      return { result: failedResult };
    }

    // Step 8: Harvest produced authentic artifacts from Gradle output directories
    let apkBuffer: Buffer | undefined;
    let aabBuffer: Buffer | undefined;
    const apkFilename = `${config.appName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${options.mode}.apk`;
    const aabFilename = `${config.appName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${options.mode}.aab`;

    const baseArtifactsDir = path.resolve(process.cwd(), '.android_artifacts');
    const artifactsDir = path.resolve(baseArtifactsDir, buildId);
    if (!fs.existsSync(artifactsDir)) {
      fs.mkdirSync(artifactsDir, { recursive: true });
    }

    if (options.target === 'apk' || options.target === 'both') {
      const candidates = [
        path.join(workspaceDir, 'app', 'build', 'outputs', 'apk', options.mode, `app-${options.mode}.apk`),
        path.join(workspaceDir, 'app', 'build', 'outputs', 'apk', options.mode, `app-${options.mode}-unsigned.apk`),
        path.join(workspaceDir, 'app', 'build', 'outputs', 'apk', options.mode, 'app.apk')
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          apkBuffer = fs.readFileSync(cand);
          addLog('INFO', 'HARVEST', `Harvested genuine APK (${apkBuffer.length} bytes) from Gradle output`);
          const targetApkPath = assertScopedArtifactPath(baseArtifactsDir, buildId, apkFilename);
          fs.writeFileSync(targetApkPath, apkBuffer);
          break;
        }
      }
    }

    if (options.target === 'aab' || options.target === 'both') {
      const candidates = [
        path.join(workspaceDir, 'app', 'build', 'outputs', 'bundle', options.mode, `app-${options.mode}.aab`),
        path.join(workspaceDir, 'app', 'build', 'outputs', 'bundle', options.mode, `app-${options.mode}-unsigned.aab`),
        path.join(workspaceDir, 'app', 'build', 'outputs', 'bundle', options.mode, 'app.aab')
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          aabBuffer = fs.readFileSync(cand);
          addLog('INFO', 'HARVEST', `Harvested genuine AAB (${aabBuffer.length} bytes) from Gradle output`);
          const targetAabPath = assertScopedArtifactPath(baseArtifactsDir, buildId, aabFilename);
          fs.writeFileSync(targetAabPath, aabBuffer);
          break;
        }
      }
    }

    // Step 9: Strict Verification via Google apksigner and bundletool
    let inspection: any = { isValidApk: false, errors: ['APK not generated'] };
    let aabInspection: any = { isValidAab: false, errors: ['AAB not generated'] };

    if (apkBuffer) {
      addLog('INFO', 'VERIFY', 'Validating APK signatures strictly via Google apksigner...');
      inspection = await ApkInspector.inspect(apkBuffer, apkFilename);
      if (!inspection.isValidApk) {
        addLog('ERROR', 'VERIFY', `Strict APK inspection failed: ${inspection.errors.join('; ')}`);
        diagnostics.push(...inspection.errors.map((e: string) => ({
          severity: 'error' as const,
          file: apkFilename,
          message: e
        })));
      } else {
        addLog('INFO', 'VERIFY', `Google apksigner verification strictly PASSED: apksignerVerified=true`);
      }
    }

    if (aabBuffer) {
      addLog('INFO', 'VERIFY', 'Validating Android App Bundle strictly via Google bundletool...');
      aabInspection = await ApkInspector.inspectAab(aabBuffer, aabFilename);
      if (!aabInspection.isValidAab) {
        addLog('ERROR', 'VERIFY', `Strict AAB validation failed: ${aabInspection.errors.join('; ')}`);
        diagnostics.push(...aabInspection.errors.map((e: string) => ({
          severity: 'error' as const,
          file: aabFilename,
          message: e
        })));
      } else {
        addLog('INFO', 'VERIFY', `Google bundletool validation strictly PASSED for ${aabFilename}`);
      }
    }

    // Strict completion determination:
    let buildSuccess = false;
    if (options.target === 'apk') {
      buildSuccess = Boolean(apkBuffer && inspection.isValidApk && inspection.apksignerVerified);
    } else if (options.target === 'aab') {
      buildSuccess = Boolean(aabBuffer && aabInspection.isValidAab && aabInspection.bundletoolVerified);
    } else {
      buildSuccess = Boolean(
        apkBuffer && inspection.isValidApk && inspection.apksignerVerified &&
        aabBuffer && aabInspection.isValidAab && aabInspection.bundletoolVerified
      );
    }

    const durationMs = Date.now() - startTime;
    addLog(buildSuccess ? 'INFO' : 'ERROR', 'FINISH', `Native Android build #${buildNum} finished in ${durationMs}ms with status: ${buildSuccess ? 'SUCCESS' : 'FAILED'}`);

    const apkChecksum = apkBuffer ? crypto.createHash('sha256').update(apkBuffer).digest('hex') : undefined;
    const aabChecksum = aabBuffer ? crypto.createHash('sha256').update(aabBuffer).digest('hex') : undefined;

    const result: AndroidBuildResult = {
      id: `abuild_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      buildId,
      buildNumber: buildNum,
      timestamp: Date.now(),
      status: buildSuccess ? 'success' : 'failed',
      mode: options.mode,
      target: options.target,
      apkPath: apkBuffer ? `/api/builds/${buildId}/android/artifacts/${apkFilename}` : undefined,
      apkFilename: apkBuffer ? apkFilename : undefined,
      apkSize: apkBuffer?.length,
      apkChecksum,
      aabPath: aabBuffer ? `/api/builds/${buildId}/android/artifacts/${aabFilename}` : undefined,
      aabFilename: aabBuffer ? aabFilename : undefined,
      aabSize: aabBuffer?.length,
      aabChecksum,
      logs,
      diagnostics,
      manifestSummary: inspection.manifestSummary,
      dexSummary: inspection.dexSummary,
      signatureSummary: inspection.signatureSummary,
      durationMs,
      error: !buildSuccess ? (
        (inspection.errors?.length ? inspection.errors.join('; ') : '') ||
        (aabInspection.errors?.length ? aabInspection.errors.join('; ') : '') ||
        'Build failed strict artifact verification'
      ) : undefined
    };

    return {
      result,
      apkBuffer,
      aabBuffer
    };
  }
}
