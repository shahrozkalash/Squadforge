import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import { db } from '../server/store.js';
import { 
  AndroidProjectGenerator, 
  AndroidBuildPipeline, 
  ApkInspector, 
  AndroidEmulatorService,
  AndroidProjectConfig 
} from '../server/android/index.js';
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

      // Root Gradle
      assert.ok(files['build.gradle.kts'], 'Must generate root build.gradle.kts');
      assert.ok(files['settings.gradle.kts'], 'Must generate root settings.gradle.kts');
      assert.ok(files['gradle.properties'], 'Must generate gradle.properties');
      assert.ok(files['gradlew'], 'Must generate POSIX gradlew wrapper');
      assert.ok(files['gradlew.bat'], 'Must generate Windows gradlew.bat wrapper');
      assert.ok(files['gradle/wrapper/gradle-wrapper.properties'], 'Must generate gradle-wrapper.properties');

      // App module
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
  // SECTION 2: DALVIK EXECUTABLE (DEX) & RESOURCES COMPILER
  // =========================================================================
  describe('2. Dalvik Executable (classes.dex) & Resource Compiler', () => {
    test('2.1 Generates valid classes.dex with authentic DEX 035 header and Adler32 checksum', () => {
      const dex = AndroidBuildPipeline.generateClassesDex('com.squadforge.fittrack', 'MainActivity');

      assert.ok(dex.length >= 112, 'DEX must be at least header size');

      // Verify Magic bytes: "dex\n035\0"
      const magic = dex.subarray(0, 8).toString('ascii');
      assert.equal(magic, 'dex\n035\0', 'Header magic must be dex\\n035\\0');

      // Verify Adler32 checksum
      const storedAdler = dex.readUInt32LE(8);
      const calculatedAdler = ApkInspector.calculateAdler32(dex.subarray(12));
      assert.equal(storedAdler, calculatedAdler, 'Adler-32 checksum must match file content');

      // Verify SHA-1 Signature
      const storedSha1 = dex.subarray(12, 32).toString('hex');
      const calculatedSha1 = crypto.createHash('sha1').update(dex.subarray(32)).digest('hex');
      assert.equal(storedSha1, calculatedSha1, 'SHA-1 signature in header must match payload');

      // Verify parseDexHeader
      const summary = ApkInspector.parseDexHeader(dex);
      assert.equal(summary.checksumValid, true, 'parseDexHeader must confirm checksum is valid');
      assert.ok(summary.methodCount > 0, 'Must contain compiled method IDs');
      assert.ok(summary.classCount > 0, 'Must contain compiled class definitions');
    });

    test('2.2 Generates compiled binary resources.arsc table with package ID 0x7F', () => {
      const arsc = AndroidBuildPipeline.generateResourcesArsc('com.squadforge.fittrack', 'FitTrack');

      assert.ok(arsc.length > 50, 'resources.arsc must not be empty');

      // Table Header: RES_TABLE_TYPE is 0x0002
      const type = arsc.readUInt16LE(0);
      assert.equal(type, 0x0002, 'Resource table type must be 0x0002 (RES_TABLE_TYPE)');

      const headerSize = arsc.readUInt16LE(2);
      assert.equal(headerSize, 12, 'ResTable_header size must be 12 bytes');

      const packageCount = arsc.readUInt32LE(8);
      assert.equal(packageCount, 1, 'Resource table must have 1 package');
    });
  });

  // =========================================================================
  // SECTION 3: APK & AAB BUILD PIPELINE & INTEGRITY VALIDATION
  // =========================================================================
  describe('3. APK & AAB Build Pipeline and Integrity Verification', () => {
    test('3.1 Successfully builds real installable Debug APK file and validates structure', async () => {
      const config = AndroidProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
      const files = AndroidProjectGenerator.generateProjectFiles(config);

      const { result, apkBuffer } = await AndroidBuildPipeline.build(
        testBuild.id,
        config,
        files,
        { mode: 'debug', target: 'apk' }
      );

      assert.equal(result.status, 'success', 'Build result must be success');
      assert.ok(apkBuffer, 'Must return raw APK buffer');
      assert.ok(apkBuffer.length > 500, 'APK file size must be non-trivial');
      assert.equal(result.apkFilename, 'fittrack-debug.apk', 'Filename must match convention');

      // Verify ZIP magic bytes (PK\x03\x04)
      assert.equal(apkBuffer[0], 0x50);
      assert.equal(apkBuffer[1], 0x4b);
      assert.equal(apkBuffer[2], 0x03);
      assert.equal(apkBuffer[3], 0x04);

      // Verify raw ZIP entries with JSZip
      const zip = await JSZip.loadAsync(apkBuffer);
      const entries = Object.keys(zip.files);

      assert.ok(entries.includes('AndroidManifest.xml'), 'APK must contain AndroidManifest.xml');
      assert.ok(entries.includes('classes.dex'), 'APK must contain classes.dex');
      assert.ok(entries.includes('resources.arsc'), 'APK must contain resources.arsc');
      assert.ok(entries.includes('META-INF/MANIFEST.MF'), 'APK must contain META-INF/MANIFEST.MF');
      assert.ok(entries.includes('META-INF/CERT.SF'), 'APK must contain META-INF/CERT.SF');
      assert.ok(entries.includes('META-INF/CERT.RSA'), 'APK must contain META-INF/CERT.RSA');

      // Verify APK Signature Scheme v2 magic string
      const magicV2 = Buffer.from('APK Sig Block 42', 'ascii');
      assert.ok(apkBuffer.includes(magicV2), 'APK must contain APK Signature Scheme v2 Block');
    });

    test('3.2 Successfully builds Android App Bundle (AAB) for Google Play release', async () => {
      const config = AndroidProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
      const files = AndroidProjectGenerator.generateProjectFiles(config);

      const { result, aabBuffer } = await AndroidBuildPipeline.build(
        testBuild.id,
        config,
        files,
        { mode: 'release', target: 'aab' }
      );

      assert.equal(result.status, 'success', 'AAB build must succeed');
      assert.ok(aabBuffer, 'Must return AAB buffer');
      assert.equal(result.aabFilename, 'fittrack-release.aab');

      // Verify AAB base split layout
      const zip = await JSZip.loadAsync(aabBuffer);
      const entries = Object.keys(zip.files);

      assert.ok(entries.includes('base/manifest/AndroidManifest.xml'), 'AAB must contain base/manifest/AndroidManifest.xml');
      assert.ok(entries.includes('base/dex/classes.dex'), 'AAB must contain base/dex/classes.dex');
      assert.ok(entries.includes('BundleConfig.pb'), 'AAB must contain BundleConfig.pb');
    });

    test('3.3 ApkInspector validates genuine APK and rejects corrupted archives', async () => {
      const config = AndroidProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
      const files = AndroidProjectGenerator.generateProjectFiles(config);

      const { apkBuffer } = await AndroidBuildPipeline.build(
        testBuild.id,
        config,
        files,
        { mode: 'debug', target: 'apk' }
      );
      assert.ok(apkBuffer);

      // Inspect valid APK
      const validInspection = await ApkInspector.inspect(apkBuffer, 'fittrack-debug.apk');
      assert.equal(validInspection.isValidApk, true, 'Inspection must report valid APK');
      assert.equal(validInspection.hasAndroidManifest, true);
      assert.equal(validInspection.hasClassesDex, true);
      assert.equal(validInspection.hasResourcesArsc, true);
      assert.equal(validInspection.hasV1Signature, true);
      assert.equal(validInspection.hasV2SignatureBlock, true);
      assert.match(validInspection.manifestSummary?.packageName || '', /^com\.squadforge\.fittrack/);
      assert.equal(validInspection.dexSummary?.checksumValid, true);

      // Inspect corrupted APK (truncated header)
      const corruptedBuf = Buffer.from('NOT_AN_APK_FILE_HEADER');
      const badInspection = await ApkInspector.inspect(corruptedBuf, 'corrupt.apk');
      assert.equal(badInspection.isValidApk, false, 'Corrupted buffer must be rejected');
      assert.ok(badInspection.errors.length > 0, 'Must record specific validation errors');
    });
  });

  // =========================================================================
  // SECTION 4: VIRTUAL ANDROID EMULATOR & JETPACK COMPOSE STATE
  // =========================================================================
  describe('4. Android Virtual Device & Jetpack Compose Emulator', () => {
    test('4.1 Initializes emulator state with realistic device specs and Compose tree', () => {
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

    test('4.2 Dispatches navigation and permission actions updating UI state', () => {
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
    });
  });

  // =========================================================================
  // SECTION 5: SECURITY & HUMAN APPROVAL GATE
  // =========================================================================
  describe('5. Security, Keystores & Approval Gates', () => {
    test('5.1 Sensitive Android permissions require human approval gate', () => {
      // SENSITIVE permissions include RECEIVE_BOOT_COMPLETED, SYSTEM_ALERT_WINDOW, RECORD_AUDIO, ACCESS_FINE_LOCATION
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

    test('5.2 Release production build triggers human authorization gate', () => {
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
  // SECTION 6: ANDROID STUDIO ZIP EXPORT VERIFICATION
  // =========================================================================
  describe('6. Android Studio Project ZIP Export', () => {
    test('6.1 Generates complete Android Studio turnkey ZIP archive', async () => {
      const config = AndroidProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
      const files = AndroidProjectGenerator.generateProjectFiles(config);

      const zip = new JSZip();
      for (const [p, c] of Object.entries(files)) {
        zip.file(p, c);
      }
      zip.file('README.md', '# Android Studio Project');

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      assert.ok(zipBuffer.length > 1000, 'Export ZIP must have content');

      // Verify ZIP structure
      const parsedZip = await JSZip.loadAsync(zipBuffer);
      const entries = Object.keys(parsedZip.files);

      assert.ok(entries.includes('build.gradle.kts'));
      assert.ok(entries.includes('settings.gradle.kts'));
      assert.ok(entries.includes('gradle/wrapper/gradle-wrapper.properties'));
      assert.ok(entries.includes('app/build.gradle.kts'));
      assert.ok(entries.includes('app/src/main/AndroidManifest.xml'));
      assert.ok(entries.includes('app/src/main/java/com/squadforge/fittrack/MainActivity.kt'));
    });
  });

  // =========================================================================
  // SECTION 7: WORKSPACE ARTIFACT FILE VALIDATION & DOWNLOAD INTEGRITY
  // =========================================================================
  describe('7. Workspace Artifact File Validation & Download Check', () => {
    test('7.1 Validates generated APK exists in workspace and rejects missing files', async () => {
      const { storeArtifactBuffer, getArtifactBuffer } = await import('../server/android/androidRoutes.js');
      const config = AndroidProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
      const files = AndroidProjectGenerator.generateProjectFiles(config);

      const { result, apkBuffer } = await AndroidBuildPipeline.build(
        testBuild.id,
        config,
        files,
        { mode: 'debug', target: 'apk' }
      );
      assert.ok(apkBuffer);
      assert.ok(result.apkFilename);

      // Store in artifact cache & disk
      storeArtifactBuffer(testBuild.id, result.apkFilename, apkBuffer);

      // Verify getArtifactBuffer retrieves it
      const retrieved = getArtifactBuffer(testBuild.id, result.apkFilename);
      assert.ok(retrieved, 'Must retrieve artifact buffer');
      assert.equal(retrieved.length, apkBuffer.length);
      assert.equal(retrieved[0], 0x50); // ZIP magic 'P'
      assert.equal(retrieved[1], 0x4b); // ZIP magic 'K'

      // Check non-existent artifact validation
      const missingBuf = getArtifactBuffer(testBuild.id, 'non-existent-app.apk');
      assert.equal(missingBuf, undefined, 'Missing artifact must return undefined');

      // Validate APK integrity
      const inspection = await ApkInspector.inspect(retrieved, result.apkFilename);
      assert.equal(inspection.isValidApk, true);
      assert.equal(inspection.hasAndroidManifest, true);
      assert.equal(inspection.hasClassesDex, true);
    });
  });

  // =========================================================================
  // SECTION 8: REAL GRADLE TASKS, APKSIGNER, BUNDLETOOL & SDK DETECTION
  // =========================================================================
  describe('8. Real Gradle Tasks, apksigner, bundletool & SDK Detection', () => {
    test('8.1 Detects Android SDK dynamically and validates Windows launcher script', () => {
      const sdk = AndroidProjectGenerator.detectSdkLocation();
      assert.ok(sdk, 'Must detect valid Android SDK path');

      const windowsLauncher = AndroidProjectGenerator.getGradlewWindows();
      assert.ok(windowsLauncher.length > 500, 'Windows gradlew.bat must have content');
      assert.match(windowsLauncher, /@rem/, 'Must be valid batch script');
      assert.match(windowsLauncher, /gradle-wrapper\.jar/, 'Must reference gradle-wrapper.jar');

      const wrapperJar = AndroidProjectGenerator.getWrapperJarBuffer();
      assert.ok(wrapperJar.length > 10000, 'Wrapper JAR must be authentic binary (>10KB)');
      assert.equal(wrapperJar[0], 0x50);
      assert.equal(wrapperJar[1], 0x4b);
    });

    test('8.2 Runs testDebugUnitTest via Gradle on generated Kotlin project', async () => {
      const workspaceDir = path.resolve(process.cwd(), '.android_workspaces', testBuild.id);
      const res = await AndroidBuildPipeline.runGradleTasks(workspaceDir, ['testDebugUnitTest']);
      assert.equal(res.success, true, `testDebugUnitTest must pass: ${res.stderr || res.stdout}`);
    });

    test('8.3 Runs lintDebug via Gradle on generated Kotlin project', async () => {
      const workspaceDir = path.resolve(process.cwd(), '.android_workspaces', testBuild.id);
      const res = await AndroidBuildPipeline.runGradleTasks(workspaceDir, ['lintDebug']);
      assert.equal(res.success, true, `lintDebug must pass: ${res.stderr || res.stdout}`);
    });

    test('8.4 Verifies Google apksigner and bundletool validation reports', async () => {
      const { getArtifactBuffer } = await import('../server/android/androidRoutes.js');
      const apkBuffer = getArtifactBuffer(testBuild.id, 'fittrack-debug.apk');
      assert.ok(apkBuffer, 'Debug APK must exist in artifacts');

      const report = await ApkInspector.inspect(apkBuffer, 'fittrack-debug.apk');
      assert.equal(report.isValidApk, true);
      assert.equal(report.apksignerVerified, true, 'Google apksigner must verify signature');
      assert.ok(report.signatureSummary?.schemeV2, 'Must have verified v2 scheme');

      const aabBuffer = getArtifactBuffer(testBuild.id, 'fittrack-release.aab');
      if (aabBuffer) {
        const aabReport = await ApkInspector.inspectAab(aabBuffer, 'fittrack-release.aab');
        assert.equal(aabReport.isValidAab, true, 'Google bundletool must validate AAB');
        assert.equal(aabReport.bundletoolVerified, true);
      }
    });
  });
});


