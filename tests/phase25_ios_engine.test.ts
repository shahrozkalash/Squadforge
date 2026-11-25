import { test, describe } from 'node:test';
import assert from 'node:assert';
import { IosProjectGenerator } from '../server/ios/iosProjectGenerator.js';
import { IosProjectValidator } from '../server/ios/iosProjectValidator.js';
import { IosBuildPipeline, parseXcodeDiagnostics } from '../server/ios/iosBuildPipeline.js';
import type { IosProjectConfig } from '../server/ios/types.js';
import { decodePng } from '../server/imageEditor/imageCodec.js';

function cfg(overrides: Partial<IosProjectConfig> = {}): IosProjectConfig {
  return { ...IosProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack'), ...overrides };
}

const ALGORITHMS = {
  url: 'https://github.com/apple/swift-algorithms.git',
  product: 'Algorithms',
  requirement: { kind: 'upToNextMajor', minimumVersion: '1.2.0' } as const
};

describe('SquadForge Phase 25: Native iOS Development Engine Test Suite', () => {
  describe('1. Project generation', () => {
    test('1.1 A complete Xcode project is generated and structurally valid', () => {
      const config = cfg();
      const files = IosProjectGenerator.generateProjectFiles(config);
      for (const expected of [
        'FitTrack.xcodeproj/project.pbxproj',
        'FitTrack/FitTrackApp.swift',
        'FitTrack/ContentView.swift',
        'FitTrack/Views/ItemDetailView.swift',
        'FitTrack/Components/ItemRowView.swift',
        'FitTrack/Models/Item.swift',
        'FitTrack/ViewModels/ItemListViewModel.swift',
        'FitTrack/Info.plist',
        'FitTrack/Assets.xcassets/AppIcon.appiconset/AppIcon1024.png',
        'FitTrack/Assets.xcassets/AccentColor.colorset/Contents.json',
        'README.md'
      ]) {
        assert.ok(files[expected], `missing ${expected}`);
      }
      const validation = IosProjectValidator.validateProjectFiles(files, config);
      assert.equal(validation.valid, true, validation.errors.join('; '));
    });

    test('1.2 Generation is deterministic (same config, byte-identical project)', () => {
      const a = IosProjectGenerator.generateProjectFiles(cfg());
      const b = IosProjectGenerator.generateProjectFiles(cfg());
      assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
      for (const key of Object.keys(a)) assert.equal(a[key], b[key], `nondeterministic file: ${key}`);
    });

    test('1.3 Swift sources form a real SwiftUI app (entry, navigation, MVVM)', () => {
      const files = IosProjectGenerator.generateProjectFiles(cfg());
      assert.match(files['FitTrack/FitTrackApp.swift'], /@main\s+struct FitTrackApp: App/);
      assert.match(files['FitTrack/ContentView.swift'], /NavigationStack/);
      assert.match(files['FitTrack/ContentView.swift'], /NavigationLink/);
      assert.match(files['FitTrack/ViewModels/ItemListViewModel.swift'], /ObservableObject/);
      // Swift string interpolation must render as \(...), not an escaped literal
      assert.ok(files['FitTrack/ViewModels/ItemListViewModel.swift'].includes('\\(items.count + 1)'));
      assert.ok(!files['FitTrack/ViewModels/ItemListViewModel.swift'].includes('\\\\('));
      // SDKROOT must pin the project to iOS: without it Xcode defaults
      // to macOS destinations and no iOS Simulator build is possible
      // (proven by the first genuine macOS CI run, Phase 25).
      assert.ok(files['FitTrack.xcodeproj/project.pbxproj'].includes('SDKROOT = iphoneos;'));
      // SWIFT_VERSION in the pbxproj is a language mode, not the toolchain version
      assert.ok(files['FitTrack.xcodeproj/project.pbxproj'].includes('SWIFT_VERSION = 5.0;'));
      assert.equal(IosProjectGenerator.swiftLanguageMode('5.9'), '5.0');
      assert.equal(IosProjectGenerator.swiftLanguageMode('6.0'), '6.0');
      assert.equal(IosProjectGenerator.swiftLanguageMode('4.2'), '4.2');
    });

    test('1.4 The app icon is a genuine 1024×1024 PNG in the accent color', () => {
      const files = IosProjectGenerator.generateProjectFiles(cfg({ accentColorHex: '#0A84FF' }));
      const png = Buffer.from(files['FitTrack/Assets.xcassets/AppIcon.appiconset/AppIcon1024.png'], 'base64');
      const img = decodePng(png);
      assert.equal(img.width, 1024);
      assert.equal(img.height, 1024);
      const i = (10 * 1024 + 10) * 4; // top-left corner = accent color
      assert.deepEqual([img.data[i], img.data[i + 1], img.data[i + 2]], [0x0a, 0x84, 0xff]);
    });

    test('1.5 Module names are sanitized into valid Swift identifiers', () => {
      assert.equal(IosProjectGenerator.sanitizeModuleName('My Cool App!'), 'MyCoolApp');
      assert.equal(IosProjectGenerator.sanitizeModuleName('3D Racer'), 'App3DRacer');
      assert.equal(IosProjectGenerator.sanitizeModuleName('!!!'), 'App');
    });
  });

  describe('2. Configuration validation & permissions', () => {
    test('2.1 Invalid configs are rejected with specific errors', () => {
      const cases: Array<[Partial<IosProjectConfig>, RegExp]> = [
        [{ bundleId: 'fittrack' }, /bundleId/],
        [{ bundleId: 'com..app' }, /bundleId/],
        [{ appName: '../evil' }, /path separators/],
        [{ appName: 'Bad "Name"' }, /quotes/],
        [{ moduleName: '9Bad' }, /Swift identifier/],
        [{ deploymentTarget: '9.0' }, /below 13\.0/],
        [{ deploymentTarget: 'sixteen' }, /deploymentTarget/],
        [{ marketingVersion: 'v1' }, /marketingVersion/],
        [{ buildNumber: 'one' }, /buildNumber/],
        [{ teamId: 'short' }, /teamId/],
        [{ accentColorHex: 'blue' }, /accentColorHex/]
      ];
      for (const [overrides, pattern] of cases) {
        const result = IosProjectGenerator.validateConfig(cfg(overrides));
        assert.equal(result.valid, false, `expected invalid: ${JSON.stringify(overrides)}`);
        assert.ok(result.errors.some((e) => pattern.test(e)), `expected /${pattern}/ in: ${result.errors.join('; ')}`);
      }
      assert.equal(IosProjectGenerator.validateConfig(cfg()).valid, true);
      assert.equal(IosProjectGenerator.validateConfig(cfg({ teamId: 'ABCDE12345' })).valid, true);
    });

    test('2.2 Permissions land in Info.plist; notifications stays runtime-only', () => {
      const config = cfg({ permissions: ['camera', 'locationWhenInUse', 'notifications', 'faceId'] });
      const files = IosProjectGenerator.generateProjectFiles(config);
      const plist = files['FitTrack/Info.plist'];
      assert.ok(plist.includes('NSCameraUsageDescription'));
      assert.ok(plist.includes('NSLocationWhenInUseUsageDescription'));
      assert.ok(plist.includes('NSFaceIDUsageDescription'));
      assert.ok(!plist.includes('NSUserNotification'), 'notifications must not invent a plist key');
      assert.equal(IosProjectValidator.validateProjectFiles(files, config).valid, true);
    });
  });

  describe('3. Swift Package Manager dependencies', () => {
    test('3.1 Dependencies are wired through the pbxproj (reference, product, frameworks)', () => {
      const config = cfg({ dependencies: [ALGORITHMS] });
      const files = IosProjectGenerator.generateProjectFiles(config);
      const pbx = files['FitTrack.xcodeproj/project.pbxproj'];
      assert.ok(pbx.includes('isa = XCRemoteSwiftPackageReference;'));
      assert.ok(pbx.includes('repositoryURL = "https://github.com/apple/swift-algorithms.git";'));
      assert.ok(pbx.includes('kind = upToNextMajorVersion; minimumVersion = 1.2.0;'));
      assert.ok(pbx.includes('isa = XCSwiftPackageProductDependency;'));
      assert.ok(pbx.includes('productName = Algorithms;'));
      assert.ok(pbx.includes('/* Algorithms in Frameworks */'));
      assert.ok(pbx.includes('packageReferences = ('));
      assert.equal(IosProjectValidator.validateProjectFiles(files, config).valid, true);
    });

    test('3.2 exact / branch / revision requirements render correctly', () => {
      const config = cfg({
        dependencies: [
          { url: 'https://github.com/a/b.git', product: 'B', requirement: { kind: 'exact', version: '2.0.1' } },
          { url: 'https://github.com/a/c.git', product: 'C', requirement: { kind: 'branch', branch: 'develop' } },
          { url: 'https://github.com/a/d.git', product: 'D', requirement: { kind: 'revision', revision: '0123456789abcdef0123456789abcdef01234567' } }
        ]
      });
      const pbx = IosProjectGenerator.generateProjectFiles(config)['FitTrack.xcodeproj/project.pbxproj'];
      assert.ok(pbx.includes('kind = exactVersion; version = 2.0.1;'));
      assert.ok(pbx.includes('kind = branch; branch = develop;'));
      assert.ok(pbx.includes('kind = revision; revision = 0123456789abcdef'));
      assert.equal(IosProjectGenerator.validateConfig(config).valid, true);
    });

    test('3.3 Unsafe or malformed dependencies are rejected', () => {
      const bad: Array<[IosProjectConfig['dependencies'], RegExp]> = [
        [[{ url: 'http://github.com/a/b.git', product: 'B', requirement: { kind: 'exact', version: '1.0.0' } }], /https/],
        [[{ url: 'https://user:secret@github.com/a/b.git', product: 'B', requirement: { kind: 'exact', version: '1.0.0' } }], /credentials/],
        [[{ url: 'https://github.com/a/b.git', product: 'B', requirement: { kind: 'upToNextMajor', minimumVersion: '1.2' } }], /semver/],
        [[ALGORITHMS, ALGORITHMS], /[Dd]uplicate/]
      ];
      for (const [dependencies, pattern] of bad) {
        const result = IosProjectGenerator.validateConfig(cfg({ dependencies }));
        assert.equal(result.valid, false);
        assert.ok(result.errors.some((e) => pattern.test(e)), `expected /${pattern}/ in: ${result.errors.join('; ')}`);
      }
    });
  });

  describe('4. Project validator catches tampering', () => {
    test('4.1 Missing files, edited settings, and injected secrets all fail', () => {
      const config = cfg({ permissions: ['camera'] });
      const files = IosProjectGenerator.generateProjectFiles(config);

      const missing = { ...files };
      delete missing['FitTrack/Models/Item.swift'];
      assert.equal(IosProjectValidator.validateProjectFiles(missing, config).valid, false);

      const retargeted = { ...files };
      retargeted['FitTrack.xcodeproj/project.pbxproj'] = files['FitTrack.xcodeproj/project.pbxproj'].replaceAll(
        'com.squadforge.fittrack',
        'com.evil.other'
      );
      const r2 = IosProjectValidator.validateProjectFiles(retargeted, config);
      assert.equal(r2.valid, false);
      assert.ok(r2.errors.some((e) => e.includes('bundle identifier')));

      const stripped = { ...files };
      stripped['FitTrack/Info.plist'] = files['FitTrack/Info.plist'].replace('NSCameraUsageDescription', 'NSNothing');
      assert.equal(IosProjectValidator.validateProjectFiles(stripped, config).valid, false);

      const secret = { ...files, 'README.md': files['README.md'] + '\n-----BEGIN PRIVATE KEY-----\n' };
      const r4 = IosProjectValidator.validateProjectFiles(secret, config);
      assert.equal(r4.valid, false);
      assert.ok(r4.errors.some((e) => e.includes('secret')));
    });
  });

  describe('5. Build reporting honesty (this host is not macOS)', () => {
    test('5.1 Environment detection states the macOS requirement plainly', async () => {
      const env = await IosBuildPipeline.detectEnvironment();
      if (process.platform === 'darwin') {
        assert.equal(env.isMac, true);
      } else {
        assert.equal(env.isMac, false);
        assert.equal(env.xcodeVersion, null);
        assert.match(env.reason ?? '', /macOS/);
        const support = await IosBuildPipeline.describeRuntimeSupport();
        assert.match(support.simulator, /Unavailable/);
      }
    });

    test('5.2 A build on a non-Mac host is environment-unavailable, never success, no artifacts', async () => {
      if (process.platform === 'darwin') return; // genuine path is exercised by the macOS CI workflow
      const config = cfg();
      const files = IosProjectGenerator.generateProjectFiles(config);
      const result = await IosBuildPipeline.build('phase25_test_honesty', config, files, { exportIpa: true });
      assert.equal(result.status, 'environment-unavailable');
      assert.equal(result.artifacts.length, 0);
      assert.ok(result.error && /macOS/.test(result.error));
      assert.ok(result.ipaNote && /not attempted/.test(result.ipaNote));
      assert.ok(result.logs.some((l) => l.step === 'ENV'));
    });

    test('5.3 xcodebuild diagnostics are parsed and deduplicated', () => {
      const output = [
        '/work/FitTrack/ContentView.swift:12:9: error: cannot find \'Foo\' in scope',
        '/work/FitTrack/ContentView.swift:12:9: error: cannot find \'Foo\' in scope',
        '/work/FitTrack/Models/Item.swift:3:1: warning: some warning',
        'note: Using codesigning identity override',
        '/work/FitTrack/App.swift:1:1: note: a note'
      ].join('\n');
      const diags = parseXcodeDiagnostics(output);
      assert.equal(diags.length, 3);
      assert.equal(diags[0].severity, 'error');
      assert.equal(diags[0].line, 12);
      assert.equal(diags[0].column, 9);
      assert.equal(diags[1].severity, 'warning');
      assert.equal(diags[2].severity, 'info');
    });
  });
});
