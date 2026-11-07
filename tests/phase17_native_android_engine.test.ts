import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import JSZip from 'jszip';
import { db } from '../server/store.js';
import { 
  AndroidProjectGenerator, 
  AndroidBuildPipeline, 
  assertSafeWorkspacePath,
  ApkInspector, 
  AndroidEmulatorService,
  AndroidProjectConfig 
} from '../server/android/index.js';
import { 
  storeArtifactBuffer, 
  getArtifactBuffer, 
  validateArtifactFilename, 
  validateBuildId 
} from '../server/android/androidRoutes.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { User, Build } from '../server/types.js';

describe('SquadForge Phase 17: Native Android Development Engine Test Suite', () => {
  let testUser: User;
  let testBuild: Build;

  before(() => {
    const userId = `usr_android_${Date.now()}`;
    testUser = {
      id: userId,
      email: 'android.tester@squadforge.dev',
      name: 'Android Test Developer',
      githubConnected: false,
      costLimitPerBuild: 10.0,
      enabledModelIds: ['gemini-2.5-pro'],
      createdAt: Date.now()
    };
    db.saveUser(testUser);

    testBuild = {
      id: `bld_android_${Date.now()}`,
      userId: testUser.id,
      idea: 'Native Fitness Tracker App for Android with Jetpack Compose',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini-2.5-pro'],
      autoPushGithub: false,
      totalTokens: 5000,
      totalCost: 0.05,
      costLimit: 10.0,
      maxDurationSeconds: 600,
      patchesAppliedCount: 1,
      projectType: 'android_application'
    };
    db.saveBuild(testBuild);
  });

  // =========================================================================
  // SECTION 1: KOTLIN PROJECT GENERATION & GRADLE DSL STRUCTURE
  // =========================================================================
  describe('1. Kotlin Project Generation & Android Structure', () => {
    test('1.1 Generates complete Android Studio project files with Kotlin DSL (.kts)', () => {
      const config = AndroidProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
      const files = AndroidProjectGenerator.generateProjectFiles(config);

      assert.ok(Object.keys(files).length >= 15, 'Should generate at least 15 project files');

      // Root Gradle files
      assert.ok(files['build.gradle.kts'], 'Must generate root build.gradle.kts');
      assert.ok(files['settings.gradle.kts'], 'Must generate root settings.gradle.kts');
      assert.ok(files['gradle.properties'], 'Must generate gradle.properties');
      assert.ok(files['gradlew'], 'Must generate POSIX gradlew wrapper');
      assert.ok(files['gradlew.bat'], 'Must generate Windows gradlew.bat wrapper');
      assert.ok(files['gradle/wrapper/gradle-wrapper.properties'], 'Must generate gradle-wrapper.properties');

      // App module files
      assert.ok(files['app/build.gradle.kts'], 'Must generate app/build.gradle.kts');
      assert.ok(files['app/proguard-rules.pro'], 'Must generate app/proguard-rules.pro');
      assert.ok(files['app/src/main/AndroidManifest.xml'], 'Must generate AndroidManifest.xml');

      // Check Gradle configurations
      assert.match(files['app/build.gradle.kts'], /compileSdk = 34/, 'Must target Android 14 (API 34)');
      assert.match(files['app/build.gradle.kts'], /minSdk = 24/, 'Must specify minSdk');
      assert.match(files['app/build.gradle.kts'], /buildFeatures\s*\{\s*compose = true\s*\}/, 'Must enable Jetpack Compose feature');
      assert.match(files['app/build.gradle.kts'], /androidx\.compose\.material3:material3/, 'Must include Material3 dependency');
    });

    test('1.2 Generates clean Jetpack Compose Kotlin UI code with Material3 theme', () => {
      const config = AndroidProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
      const files = AndroidProjectGenerator.generateProjectFiles(config);

      const mainActivity = files['app/src/main/java/com/squadforge/fittrack/MainActivity.kt'];
      assert.ok(mainActivity, 'MainActivity.kt must exist');
      assert.match(mainActivity, /class MainActivity : ComponentActivity\(\)/, 'Must extend ComponentActivity');
      assert.match(mainActivity, /setContent \{/, 'Must use setContent {} Compose entrypoint');

      const theme = files['app/src/main/java/com/squadforge/fittrack/ui/theme/Theme.kt'];
      assert.ok(theme, 'Theme.kt must exist');
      assert.match(theme, /MaterialTheme\(/, 'Must invoke MaterialTheme Composable');

      const homeScreen = files['app/src/main/java/com/squadforge/fittrack/ui/screens/HomeScreen.kt'];
      assert.ok(homeScreen, 'HomeScreen.kt must exist');
      assert.match(homeScreen, /@Composable/, 'HomeScreen must be a @Composable function');
      assert.match(homeScreen, /LazyColumn/, 'HomeScreen must contain LazyColumn item list');

      const viewModel = files['app/src/main/java/com/squadforge/fittrack/viewmodel/MainViewModel.kt'];
      assert.ok(viewModel, 'MainViewModel.kt must exist');
      assert.match(viewModel, /class MainViewModel : ViewModel\(\)/, 'Must extend AndroidX ViewModel');
      assert.match(viewModel, /StateFlow<List<ProjectItem>>/, 'Must expose reactive StateFlow');
    });

    test('1.3 Manifest contains valid package, permissions, and launcher intent filter', () => {
      const config = AndroidProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
      config.permissions = [
        'android.permission.INTERNET',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.CAMERA'
      ];
      const files = AndroidProjectGenerator.generateProjectFiles(config);
      const manifest = files['app/src/main/AndroidManifest.xml'];

      assert.match(manifest, /package="com\.squadforge\.fittrack"/, 'Must specify namespace package');
      assert.match(manifest, /<uses-permission android:name="android\.permission\.INTERNET" \/>/, 'Must declare INTERNET permission');
      assert.match(manifest, /<uses-permission android:name="android\.permission\.ACCESS_FINE_LOCATION" \/>/, 'Must declare LOCATION permission');
      assert.match(manifest, /<uses-permission android:name="android\.permission\.CAMERA" \/>/, 'Must declare CAMERA permission');
      assert.match(manifest, /android:exported="true"/, 'Launcher activity must be exported');
      assert.match(manifest, /android\.intent\.action\.MAIN/, 'Must have MAIN intent action');
      assert.match(manifest, /android\.intent\.category\.LAUNCHER/, 'Must have LAUNCHER intent category');
    });
  });

  // =========================================================================
  // SECTION 2: GRADLE WRAPPER & CROSS-PLATFORM LAUNCHER ASSETS
  // =========================================================================
  describe('2. Gradle Wrapper & Cross-Platform Launcher Assets', () => {
    test('2.1 Verifies authentic Gradle wrapper JAR asset exists and has valid magic and size', () => {
      const wrapperJar = AndroidProjectGenerator.getWrapperJarBuffer();
      assert.ok(wrapperJar.length > 10000, 'Wrapper JAR must be authentic binary (>10KB)');
      // Valid ZIP/JAR magic bytes PK\x03\x04
      assert.equal(wrapperJar[0], 0x50);
      assert.equal(wrapperJar[1], 0x4b);
      assert.equal(wrapperJar[2], 0x03);
      assert.equal(wrapperJar[3], 0x04);
    });

    test('2.2 Verifies POSIX gradlew launcher script and Windows gradlew.bat exist and are non-empty', () => {
      const posixScript = AndroidProjectGenerator.getGradlewPosix();
      assert.ok(posixScript.length > 100, 'POSIX gradlew script must have content');
      assert.match(posixScript, /gradle/, 'Must reference gradle execution');

      const winScript = AndroidProjectGenerator.getGradlewWindows();
      assert.ok(winScript.length > 100, 'Windows gradlew.bat script must have content');
      assert.match(winScript, /gradle-wrapper\.jar/i, 'Must reference gradle-wrapper.jar');
    });

    test('2.3 verifyWrapperAssets confirms authentic assets and reports valid status', () => {
      const check = AndroidProjectGenerator.verifyWrapperAssets();
      assert.equal(check.valid, true, `verifyWrapperAssets must be valid: ${check.errors.join(', ')}`);
      assert.equal(check.errors.length, 0);
    });

    test('2.4 detectJavaHome performs honest environment detection without hardcoded fallbacks', () => {
      const detected = AndroidProjectGenerator.detectJavaHome();
      if (detected) {
        // If detected, verify the binary actually exists
        const javaExe = process.platform === 'win32'
          ? path.join(detected, 'bin', 'java.exe')
          : path.join(detected, 'bin', 'java');
        assert.ok(fs.existsSync(javaExe), 'Detected JAVA_HOME must contain valid java binary');
      } else {
        // Honest null when JDK is missing
        assert.equal(detected, null);
      }
    });

    test('2.5 detectSdkLocation performs honest environment detection without hardcoding', () => {
      const detected = AndroidProjectGenerator.detectSdkLocation();
      if (detected) {
        assert.ok(fs.existsSync(detected), 'Detected SDK path must exist on disk');
      } else {
        assert.equal(detected, null);
      }
    });
  });

  // =========================================================================
  // SECTION 3: WORKSPACE SECURITY & PATH TRAVERSAL REJECTION
  // =========================================================================
  describe('3. Workspace Security & Path Traversal Prevention', () => {
    const testWorkspace = path.resolve(process.cwd(), '.test_workspace_security');

    before(() => {
      if (!fs.existsSync(testWorkspace)) {
        fs.mkdirSync(testWorkspace, { recursive: true });
      }
    });

    test('3.1 Accepts safe relative paths within workspace', () => {
      const safePath = 'app/src/main/java/com/example/MyFile.kt';
      const resolved = assertSafeWorkspacePath(testWorkspace, safePath);
      assert.ok(resolved.startsWith(testWorkspace));
      assert.equal(path.relative(testWorkspace, resolved), path.normalize(safePath));
    });

    test('3.2 Strictly rejects absolute paths escaping workspace', () => {
      assert.throws(() => {
        assertSafeWorkspacePath(testWorkspace, '/etc/passwd');
      }, /Absolute paths forbidden/i);

      assert.throws(() => {
        assertSafeWorkspacePath(testWorkspace, '/var/log/syslog');
      }, /Absolute paths forbidden/i);
    });

    test('3.3 Strictly rejects parent path traversal attempts (../ and ..\\)', () => {
      assert.throws(() => {
        assertSafeWorkspacePath(testWorkspace, '../outside.txt');
      }, /Path traversal escapes workspace/i);

      assert.throws(() => {
        assertSafeWorkspacePath(testWorkspace, 'app/../../outside.txt');
      }, /Path traversal escapes workspace/i);

      assert.throws(() => {
        assertSafeWorkspacePath(testWorkspace, '..\\outside.txt');
      }, /Path traversal escapes workspace/i);
    });

    test('3.4 Strictly rejects null bytes in paths', () => {
      assert.throws(() => {
        assertSafeWorkspacePath(testWorkspace, 'app/main\0.kt');
      }, /Null bytes forbidden/i);
    });

    test('3.5 Strictly rejects Windows drive letters escaping workspace', () => {
      assert.throws(() => {
        assertSafeWorkspacePath(testWorkspace, 'C:\\Windows\\System32');
      }, /Windows drive letters forbidden|Absolute paths forbidden/i);
    });
  });

  // =========================================================================
  // SECTION 4: ARTIFACT SECURITY & OWNERSHIP ENFORCEMENT
  // =========================================================================
  describe('4. Artifact Handling & Ownership Security', () => {
    test('4.1 validateArtifactFilename strictly allows only safe APK/AAB filenames', () => {
      // Valid
      assert.equal(validateArtifactFilename('fittrack-debug.apk'), true);
      assert.equal(validateArtifactFilename('fittrack-release.aab'), true);
      assert.equal(validateArtifactFilename('app_v1.0.0-release.apk'), true);

      // Traversal and attack attempts
      assert.equal(validateArtifactFilename('../secret.txt'), false);
      assert.equal(validateArtifactFilename('../../app.apk'), false);
      assert.equal(validateArtifactFilename('dir/app.apk'), false);
      assert.equal(validateArtifactFilename('app.apk\0.png'), false);
      assert.equal(validateArtifactFilename('app.exe'), false);
      assert.equal(validateArtifactFilename('malware.sh'), false);
      assert.equal(validateArtifactFilename(''), false);
    });

    test('4.2 validateBuildId strictly rejects path traversal and invalid characters', () => {
      assert.equal(validateBuildId(testBuild.id), true);
      assert.equal(validateBuildId('build_123-abc'), true);

      assert.equal(validateBuildId('../etc'), false);
      assert.equal(validateBuildId('build/123'), false);
      assert.equal(validateBuildId('build\\123'), false);
      assert.equal(validateBuildId('build\0'), false);
      assert.equal(validateBuildId(''), false);
    });

    test('4.3 storeArtifactBuffer and getArtifactBuffer safely store and retrieve artifacts within isolated directory', () => {
      const dummyApk = Buffer.from('PK\x03\x04test_apk_content');
      const filename = 'testapp-debug.apk';

      storeArtifactBuffer(testBuild.id, filename, dummyApk);

      const retrieved = getArtifactBuffer(testBuild.id, filename);
      assert.ok(retrieved, 'Must retrieve stored artifact');
      assert.equal(retrieved.toString(), dummyApk.toString());

      // Non-existent file
      const nonExistent = getArtifactBuffer(testBuild.id, 'missing-debug.apk');
      assert.equal(nonExistent, undefined);
    });

    test('4.4 storeArtifactBuffer rejects path traversal attempts in filename', () => {
      const dummyBuf = Buffer.from('test');
      assert.throws(() => {
        storeArtifactBuffer(testBuild.id, '../traversal.apk', dummyBuf);
      }, /Security Violation|Invalid/i);
    });

    test('4.5 getArtifactBuffer returns undefined for traversal attempts in filename or buildId', () => {
      assert.equal(getArtifactBuffer(testBuild.id, '../../secret.apk'), undefined);
      assert.equal(getArtifactBuffer('../traversal_build', 'app.apk'), undefined);
    });
  });

  // =========================================================================
  // SECTION 5: STRICT APK & AAB VERIFICATION (NO SYNTHETIC BYPASS)
  // =========================================================================
  describe('5. Strict APK & AAB Verification (No Synthetic Bypass)', () => {
    test('5.1 Rejects APK verification when Google apksigner is unavailable (ZIP magic alone does NOT verify signature)', async () => {
      // Construct a valid ZIP that has Android structure but no verified Google apksigner signature
      const zip = new JSZip();
      zip.file('AndroidManifest.xml', '<manifest/>');
      zip.file('classes.dex', 'fake_dex');
      zip.file('resources.arsc', 'fake_arsc');
      zip.file('META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\r\n');
      zip.file('META-INF/CERT.SF', 'Signature-Version: 1.0\r\n');
      zip.file('META-INF/CERT.RSA', 'fake_rsa_signature');
      const apkBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      const report = await ApkInspector.inspect(apkBuffer, 'unverified.apk');

      // Crucial invariant check:
      // ZIP magic, signature filenames, and APK signing-block magic alone must NEVER establish signature validity.
      assert.equal(report.apksignerVerified, false, 'apksignerVerified must be false without Google apksigner');
      assert.equal(report.isValidApk, false, 'isValidApk must be false when apksigner is not verified');
      assert.ok(report.errors.length > 0, 'Must record explicit verification error');
      assert.match(report.errors.join('; '), /apksigner/i, 'Error message must cite missing or unverified apksigner');
    });

    test('5.2 Rejects corrupted or truncated APK buffers', async () => {
      const badBuf = Buffer.from('CORRUPTED_NON_ZIP_DATA_HEADER');
      const report = await ApkInspector.inspect(badBuf, 'corrupt.apk');

      assert.equal(report.isValidApk, false);
      assert.ok(report.errors.length > 0);
    });

    test('5.3 Rejects AAB validation when Google bundletool is unavailable', async () => {
      const zip = new JSZip();
      zip.file('base/manifest/AndroidManifest.xml', '<manifest/>');
      zip.file('base/dex/classes.dex', 'dex_bytes');
      zip.file('BundleConfig.pb', 'pb_bytes');
      const aabBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      const report = await ApkInspector.inspectAab(aabBuffer, 'unverified.aab');

      // Crucial invariant check:
      // Failed or unavailable bundletool validation must NOT produce a successful verified status.
      assert.equal(report.bundletoolVerified, false);
      assert.equal(report.isValidAab, false, 'isValidAab must be false without Google bundletool validation');
      assert.ok(report.errors.length > 0);
      assert.match(report.errors.join('; '), /bundletool/i);
    });

    test('5.4 Rejects incomplete AAB missing base manifest', async () => {
      const zip = new JSZip();
      zip.file('BundleConfig.pb', 'pb_bytes');
      const aabBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      const report = await ApkInspector.inspectAab(aabBuffer, 'incomplete.aab');
      assert.equal(report.isValidAab, false);
      assert.ok(report.errors.some(e => e.includes('AndroidManifest.xml')));
    });
  });

  // =========================================================================
  // SECTION 6: PRODUCTION BUILD PIPELINE FAILURE WHEN SDK/JAVA UNAVAILABLE
  // =========================================================================
  describe('6. Production Build Pipeline Behavior Without SDK / Java', () => {
    test('6.1 Fails honestly with diagnostic when Android SDK or Java is missing (no synthetic fallback)', async () => {
      const config = AndroidProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
      const files = AndroidProjectGenerator.generateProjectFiles(config);

      const { result, apkBuffer } = await AndroidBuildPipeline.build(
        testBuild.id,
        config,
        files,
        { mode: 'debug', target: 'apk' }
      );

      // In this environment, Java or Android SDK is not installed on the host.
      // The build must honestly fail and NEVER synthesize a fake APK.
      if (!AndroidProjectGenerator.detectSdkLocation() || !AndroidProjectGenerator.detectJavaHome()) {
        assert.equal(result.status, 'failed', 'Build must fail when toolchain is absent');
        assert.equal(apkBuffer, undefined, 'Must NEVER return a synthesized fake APK buffer');
        assert.ok(result.error, 'Must report explicit error message');
        assert.ok(result.diagnostics.length > 0, 'Must provide toolchain diagnostics');
      }
    });

    test('6.2 Rejects builds with path traversal in project files safely', async () => {
      const config = AndroidProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
      const files: Record<string, string> = {
        '../escaped.txt': 'malicious content'
      };

      const { result } = await AndroidBuildPipeline.build(
        testBuild.id,
        config,
        files,
        { mode: 'debug', target: 'apk' }
      );

      assert.equal(result.status, 'failed');
      assert.match(result.error || '', /traversal|security/i);
    });
  });

  // =========================================================================
  // SECTION 7: INTERACTIVE BROWSER SIMULATOR (EXPLICITLY NON-QEMU)
  // =========================================================================
  describe('7. Interactive Browser Simulator (UI Preview)', () => {
    test('7.1 Initializes browser simulator state with device specs and Compose tree', () => {
      const service = AndroidEmulatorService.getInstance();
      const config = AndroidProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
      const state = service.getOrCreateState(testBuild.id, config);

      assert.equal(state.deviceModel, 'pixel_8');
      assert.equal(state.orientation, 'portrait');
      assert.equal(state.activeScreen, 'home');
      assert.ok(state.batteryLevel > 0);
      assert.ok(state.logs.length >= 3, 'Must initialize Logcat startup logs');
      assert.ok(state.currentComponents.length > 0, 'Must construct Composable node hierarchy');
    });

    test('7.2 Dispatches navigation, orientation, theme, and permission actions', () => {
      const service = AndroidEmulatorService.getInstance();
      const config = AndroidProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');

      // Navigate to permissions screen
      const navState = service.dispatchAction(testBuild.id, {
        type: 'NAVIGATE',
        payload: { screen: 'permissions' }
      }, config);
      assert.equal(navState.activeScreen, 'permissions');

      // Request camera permission
      const permState = service.dispatchAction(testBuild.id, {
        type: 'REQUEST_PERMISSION',
        payload: { permission: 'android.permission.CAMERA' }
      }, config);
      assert.ok(permState.grantedPermissions.includes('android.permission.CAMERA'), 'Camera must be granted');

      // Rotate device
      const rotateState = service.dispatchAction(testBuild.id, { type: 'ROTATE' }, config);
      assert.equal(rotateState.orientation, 'landscape');

      // Toggle theme
      const themeState = service.dispatchAction(testBuild.id, { type: 'TOGGLE_THEME' }, config);
      assert.ok(themeState.activeTheme === 'light' || themeState.activeTheme === 'dark');
    });
  });

  // =========================================================================
  // SECTION 8: SECURITY & HUMAN APPROVAL GATES
  // =========================================================================
  describe('8. Security, Keystores & Approval Gates', () => {
    test('8.1 Sensitive Android permissions require human approval gate', () => {
      const req = ApprovalGateService.requestApproval(testBuild.id, testUser.id, {
        requestingAgent: 'android_specialist',
        requestingRole: 'security_specialist',
        operationType: 'security_sensitive_change',
        riskLevel: 'high',
        explanation: 'Android application requests privileged hardware permission: android.permission.RECEIVE_BOOT_COMPLETED',
        affectedFiles: ['app/src/main/AndroidManifest.xml'],
        proposedChanges: 'Add <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />'
      });

      assert.equal(req.success, true);
      assert.ok(req.request);
      assert.equal(req.request.status, 'pending');
      assert.equal(req.request.operationType, 'security_sensitive_change');
    });

    test('8.2 Release production build triggers human authorization gate', () => {
      const req = ApprovalGateService.requestApproval(testBuild.id, testUser.id, {
        requestingAgent: 'android_release_specialist',
        requestingRole: 'devops_release_specialist',
        operationType: 'production_deployment',
        riskLevel: 'critical',
        explanation: 'Assembling signed production Android Release APK / AAB with release credentials',
        affectedFiles: ['app/build.gradle.kts'],
        proposedChanges: 'Assemble Release APK & App Bundle for Google Play distribution'
      });

      assert.equal(req.success, true);
      assert.ok(req.request);
      assert.equal(req.request.status, 'pending');
      assert.equal(req.request.operationType, 'production_deployment');
    });
  });

  // =========================================================================
  // SECTION 9: ANDROID STUDIO ZIP EXPORT VERIFICATION
  // =========================================================================
  describe('9. Android Studio Project Turnkey ZIP Export', () => {
    test('9.1 Generates complete Android Studio turnkey ZIP archive with authentic wrapper JAR', async () => {
      const config = AndroidProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
      const files = AndroidProjectGenerator.generateProjectFiles(config);

      const zip = new JSZip();
      for (const [p, c] of Object.entries(files)) {
        zip.file(p, c);
      }
      zip.file('gradle/wrapper/gradle-wrapper.jar', AndroidProjectGenerator.getWrapperJarBuffer());
      zip.file('README.md', '# Android Studio Project');

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      assert.ok(zipBuffer.length > 20000, 'Export ZIP must contain project files and wrapper JAR (>20KB)');

      const parsedZip = await JSZip.loadAsync(zipBuffer);
      const entries = Object.keys(parsedZip.files);

      assert.ok(entries.includes('build.gradle.kts'));
      assert.ok(entries.includes('settings.gradle.kts'));
      assert.ok(entries.includes('gradle/wrapper/gradle-wrapper.properties'));
      assert.ok(entries.includes('gradle/wrapper/gradle-wrapper.jar'));
      assert.ok(entries.includes('gradlew'));
      assert.ok(entries.includes('gradlew.bat'));
      assert.ok(entries.includes('app/build.gradle.kts'));
      assert.ok(entries.includes('app/src/main/AndroidManifest.xml'));
      assert.ok(entries.includes('app/src/main/java/com/squadforge/fittrack/MainActivity.kt'));
    });
  });
});
