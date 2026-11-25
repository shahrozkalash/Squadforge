import { IosProjectConfig, IosValidationResult } from './types.js';
import { IosProjectGenerator } from './iosProjectGenerator.js';

/**
 * Phase 25 — structural validation of a generated iOS project file map.
 * This is NOT a compilation check: it verifies the project is complete
 * and internally consistent (every pbxproj reference resolves to a
 * file, the Info.plist and asset catalogs are well-formed). Genuine
 * compilation is xcodebuild's job, on macOS only.
 */
export class IosProjectValidator {
  static validateProjectFiles(files: Record<string, string>, config: IosProjectConfig): IosValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const m = config.moduleName;

    const required = [
      `${m}.xcodeproj/project.pbxproj`,
      `${m}/${m}App.swift`,
      `${m}/ContentView.swift`,
      `${m}/Info.plist`,
      `${m}/Assets.xcassets/Contents.json`,
      `${m}/Assets.xcassets/AppIcon.appiconset/Contents.json`,
      `${m}/Assets.xcassets/AppIcon.appiconset/AppIcon1024.png`,
      `${m}/Assets.xcassets/AccentColor.colorset/Contents.json`
    ];
    for (const path of required) {
      if (!(path in files)) errors.push(`missing required file: ${path}`);
    }
    if (errors.length) return { valid: false, errors, warnings };

    // --- pbxproj structure ---
    const pbx = files[`${m}.xcodeproj/project.pbxproj`];
    const depth = (pbx.match(/\{/g) ?? []).length - (pbx.match(/\}/g) ?? []).length;
    if (depth !== 0) errors.push(`project.pbxproj has unbalanced braces (depth ${depth})`);
    for (const isa of ['PBXBuildFile', 'PBXFileReference', 'PBXGroup', 'PBXNativeTarget', 'PBXProject', 'PBXSourcesBuildPhase', 'PBXFrameworksBuildPhase', 'PBXResourcesBuildPhase', 'XCBuildConfiguration', 'XCConfigurationList']) {
      if (!pbx.includes(`isa = ${isa};`)) errors.push(`project.pbxproj is missing ${isa} objects`);
    }
    if (!pbx.includes('rootObject')) errors.push('project.pbxproj has no rootObject');
    if (!pbx.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${config.bundleId};`)) {
      errors.push('project.pbxproj does not carry the configured bundle identifier');
    }
    if (!pbx.includes(`IPHONEOS_DEPLOYMENT_TARGET = ${config.deploymentTarget};`)) {
      errors.push('project.pbxproj does not carry the configured deployment target');
    }
    // Every swift file in the map must be referenced by the pbxproj, and vice versa.
    for (const path of Object.keys(files)) {
      if (path.endsWith('.swift')) {
        const name = path.split('/').pop()!;
        if (!pbx.includes(`/* ${name} */`)) errors.push(`swift file not referenced in pbxproj: ${path}`);
      }
    }
    for (const match of pbx.matchAll(/\/\* (\S+\.swift) \*\/ = \{isa = PBXFileReference/g)) {
      const referenced = match[1];
      if (!Object.keys(files).some((p) => p.endsWith(`/${referenced}`))) {
        errors.push(`pbxproj references a swift file missing from the project: ${referenced}`);
      }
    }
    if (config.dependencies.length) {
      if (!pbx.includes('XCRemoteSwiftPackageReference')) errors.push('dependencies configured but no XCRemoteSwiftPackageReference in pbxproj');
      for (const dep of config.dependencies) {
        if (!pbx.includes(`repositoryURL = "${dep.url}";`)) errors.push(`dependency not in pbxproj: ${dep.product}`);
        if (!pbx.includes(`productName = ${dep.product};`)) errors.push(`dependency product not linked: ${dep.product}`);
      }
    } else if (pbx.includes('XCRemoteSwiftPackageReference')) {
      warnings.push('pbxproj references packages but the config lists none');
    }

    // --- Info.plist ---
    const plist = files[`${m}/Info.plist`];
    if (!plist.startsWith('<?xml') || !plist.includes('<plist version="1.0">')) {
      errors.push('Info.plist is not a well-formed XML plist header');
    }
    if (!plist.includes('CFBundleIdentifier')) errors.push('Info.plist lacks CFBundleIdentifier');
    for (const perm of config.permissions) {
      const keys: Record<string, string> = {
        camera: 'NSCameraUsageDescription',
        photoLibrary: 'NSPhotoLibraryUsageDescription',
        microphone: 'NSMicrophoneUsageDescription',
        locationWhenInUse: 'NSLocationWhenInUseUsageDescription',
        faceId: 'NSFaceIDUsageDescription'
      };
      const key = keys[perm];
      if (key && !plist.includes(key)) errors.push(`Info.plist lacks ${key} for permission '${perm}'`);
    }

    // --- Asset catalogs ---
    try {
      const iconSet = JSON.parse(files[`${m}/Assets.xcassets/AppIcon.appiconset/Contents.json`]);
      const icon = (iconSet.images ?? []).find((i: any) => i.size === '1024x1024');
      if (!icon?.filename) errors.push('AppIcon.appiconset has no 1024x1024 marketing icon');
    } catch {
      errors.push('AppIcon.appiconset/Contents.json is not valid JSON');
    }
    const iconPng = Buffer.from(files[`${m}/Assets.xcassets/AppIcon.appiconset/AppIcon1024.png`], 'base64');
    if (iconPng.length < 100 || iconPng.subarray(0, 4).toString('hex') !== '89504e47') {
      errors.push('AppIcon1024.png is not a genuine PNG (bad signature or too small)');
    }
    try {
      JSON.parse(files[`${m}/Assets.xcassets/AccentColor.colorset/Contents.json`]);
    } catch {
      errors.push('AccentColor.colorset/Contents.json is not valid JSON');
    }

    // --- Swift sources ---
    const app = files[`${m}/${m}App.swift`];
    if (!app.includes('@main') || !app.includes(`struct ${m}App: App`)) {
      errors.push(`${m}App.swift does not declare the @main App entry point`);
    }
    if (!files[`${m}/ContentView.swift`].includes('NavigationStack')) {
      errors.push('ContentView.swift does not use NavigationStack');
    }
    // No secret KEY MATERIAL may ever appear in a generated project.
    // (Prose mentioning provisioning profiles in docs is fine; actual
    // private keys are not.)
    const secretPattern = /-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
    for (const [path, content] of Object.entries(files)) {
      if (secretPattern.test(content)) errors.push(`possible signing secret material in generated file: ${path}`);
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  static validateConfig(config: IosProjectConfig): IosValidationResult {
    return IosProjectGenerator.validateConfig(config);
  }
}
