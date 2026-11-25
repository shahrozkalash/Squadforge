import { createHash } from 'crypto';
import { createProject, fillRect, drawText, composite } from '../imageEditor/imageCore.js';
import { encodePng } from '../imageEditor/imageCodec.js';
import {
  IosProjectConfig,
  IosValidationResult,
  IOS_PERMISSION_PLIST_KEYS
} from './types.js';

/**
 * Phase 25 — Native iOS project generator.
 *
 * Emits a REAL Xcode project (canonical OpenStep-plist pbxproj,
 * objectVersion 56) with Swift + SwiftUI sources in an MVVM layout,
 * a physical Info.plist, an asset catalog (AppIcon with a genuine
 * PNG rendered by the Phase 19 image engine, AccentColor colorset),
 * and Swift Package Manager dependencies wired as
 * XCRemoteSwiftPackageReference objects.
 *
 * Binary convention (shared with the build pipeline): the one binary
 * file, AppIcon1024.png, is stored in the file map as a base64
 * string; every other entry is plain text.
 */
export class IosProjectGenerator {
  static sanitizeModuleName(appName: string): string {
    let name = appName.replace(/[^A-Za-z0-9_]/g, '');
    if (!name) name = 'App';
    if (/^[0-9]/.test(name)) name = `App${name}`;
    return name;
  }

  static getDefaultConfig(appName: string = 'FitTrack', bundleId: string = 'com.squadforge.fittrack'): IosProjectConfig {
    return {
      appName,
      moduleName: IosProjectGenerator.sanitizeModuleName(appName),
      bundleId,
      marketingVersion: '1.0',
      buildNumber: '1',
      deploymentTarget: '16.0',
      swiftVersion: '5.9',
      permissions: [],
      dependencies: [],
      accentColorHex: '#0A84FF'
    };
  }

  /** pbxproj SWIFT_VERSION is a language MODE (4 / 4.2 / 5.0 / 6.0), not a toolchain version. */
  static swiftLanguageMode(swiftVersion: string): string {
    if (swiftVersion.startsWith('6')) return '6.0';
    if (swiftVersion.startsWith('4.2')) return '4.2';
    if (swiftVersion.startsWith('4')) return '4';
    return '5.0';
  }

  static validateConfig(config: IosProjectConfig): IosValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!config.appName || !config.appName.trim()) errors.push('appName must not be empty');
    if (/[/\\]|\.\./.test(config.appName)) errors.push('appName must not contain path separators or traversal');
    if (/["\n\r]/.test(config.appName)) errors.push('appName must not contain quotes or newlines (it is embedded in Swift sources)');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.moduleName)) {
      errors.push(`moduleName '${config.moduleName}' is not a valid Swift identifier`);
    }
    if (config.moduleName !== IosProjectGenerator.sanitizeModuleName(config.appName)) {
      warnings.push('moduleName differs from the sanitized appName; Xcode product names should match the module');
    }
    if (!/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(config.bundleId)) {
      errors.push(`bundleId '${config.bundleId}' is not valid reverse-DNS (e.g. com.company.app)`);
    }
    if (!/^\d+\.\d+(\.\d+)?$/.test(config.marketingVersion)) errors.push('marketingVersion must look like 1.0 or 1.0.1');
    if (!/^\d+$/.test(config.buildNumber)) errors.push('buildNumber must be a positive integer');
    if (!/^\d+\.\d+$/.test(config.deploymentTarget)) {
      errors.push('deploymentTarget must look like 16.0');
    } else if (parseFloat(config.deploymentTarget) < 13.0) {
      errors.push('deploymentTarget below 13.0 is not supported by current Xcode');
    }
    if (config.teamId !== undefined && !/^[A-Z0-9]{10}$/.test(config.teamId)) {
      errors.push('teamId must be a 10-character uppercase alphanumeric Apple team identifier');
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(config.accentColorHex)) errors.push('accentColorHex must be #RRGGBB');
    const seenProducts = new Set<string>();
    for (const dep of config.dependencies) {
      let parsed: URL | null = null;
      try { parsed = new URL(dep.url); } catch { /* handled below */ }
      if (!parsed || parsed.protocol !== 'https:') {
        errors.push(`dependency '${dep.product}': URL must be a valid https URL`);
      } else {
        if (parsed.username || parsed.password) {
          errors.push(`dependency '${dep.product}': URL must not embed credentials`);
        }
        if (!parsed.pathname.endsWith('.git')) warnings.push(`dependency '${dep.product}': SPM URLs conventionally end in .git`);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(dep.product)) errors.push(`dependency product '${dep.product}' is not a valid product name`);
      if (seenProducts.has(dep.product)) errors.push(`duplicate dependency product '${dep.product}'`);
      seenProducts.add(dep.product);
      const req = dep.requirement;
      if ((req.kind === 'upToNextMajor' || req.kind === 'exact')) {
        const v = req.kind === 'upToNextMajor' ? req.minimumVersion : req.version;
        if (!/^\d+\.\d+\.\d+$/.test(v)) errors.push(`dependency '${dep.product}': version '${v}' must be full semver (x.y.z)`);
      }
      if (req.kind === 'branch' && !req.branch.trim()) errors.push(`dependency '${dep.product}': branch must not be empty`);
      if (req.kind === 'revision' && !/^[0-9a-f]{7,40}$/i.test(req.revision)) {
        errors.push(`dependency '${dep.product}': revision must be a git commit hash`);
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  /** Genuine 1024×1024 app icon PNG (base64), rendered with the Phase 19 engine. */
  static generateAppIconBase64(config: IosProjectConfig): string {
    const hex = config.accentColorHex.replace('#', '');
    const accent = {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 255
    };
    const project = createProject(1024, 1024, accent);
    const layerId = project.activeLayerId!;
    // Subtle darker band at the bottom + the app's initial, large.
    const darker = { r: Math.round(accent.r * 0.72), g: Math.round(accent.g * 0.72), b: Math.round(accent.b * 0.72), a: 255 };
    fillRect(project, layerId, { x: 0, y: 824, width: 1024, height: 200 }, darker);
    const letter = (config.moduleName.match(/[A-Za-z]/)?.[0] ?? 'A').toUpperCase();
    drawText(project, layerId, { x: 292, y: 166 }, letter, 88, { r: 255, g: 255, b: 255, a: 255 });
    return encodePng(composite(project)).toString('base64');
  }

  static generateProjectFiles(config: IosProjectConfig): Record<string, string> {
    const m = config.moduleName;
    const files: Record<string, string> = {};
    files[`${m}.xcodeproj/project.pbxproj`] = buildPbxproj(config);
    files[`${m}/${m}App.swift`] = appSwift(config);
    files[`${m}/ContentView.swift`] = contentViewSwift(config);
    files[`${m}/Views/ItemDetailView.swift`] = detailViewSwift();
    files[`${m}/Components/ItemRowView.swift`] = rowViewSwift();
    files[`${m}/Models/Item.swift`] = itemSwift();
    files[`${m}/ViewModels/ItemListViewModel.swift`] = viewModelSwift();
    files[`${m}/Info.plist`] = infoPlist(config);
    files[`${m}/Assets.xcassets/Contents.json`] = JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2) + '\n';
    files[`${m}/Assets.xcassets/AppIcon.appiconset/Contents.json`] =
      JSON.stringify(
        {
          images: [
            { filename: 'AppIcon1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }
          ],
          info: { author: 'xcode', version: 1 }
        },
        null,
        2
      ) + '\n';
    files[`${m}/Assets.xcassets/AppIcon.appiconset/AppIcon1024.png`] = IosProjectGenerator.generateAppIconBase64(config);
    files[`${m}/Assets.xcassets/AccentColor.colorset/Contents.json`] = accentColorset(config);
    files['README.md'] = readme(config);
    return files;
  }
}

// ---------------------------------------------------------------------------
// Deterministic pbxproj ids
// ---------------------------------------------------------------------------

function pid(label: string): string {
  return createHash('sha256').update(`squadforge-ios:${label}`).digest('hex').slice(0, 24).toUpperCase();
}

function requirementPbx(dep: IosProjectConfig['dependencies'][number]): string {
  const req = dep.requirement;
  switch (req.kind) {
    case 'upToNextMajor':
      return `{ kind = upToNextMajorVersion; minimumVersion = ${req.minimumVersion}; }`;
    case 'exact':
      return `{ kind = exactVersion; version = ${req.version}; }`;
    case 'branch':
      return `{ kind = branch; branch = ${req.branch}; }`;
    case 'revision':
      return `{ kind = revision; revision = ${req.revision}; }`;
  }
}

function packageNameFromUrl(url: string): string {
  const last = url.split('/').pop() ?? 'package';
  return last.replace(/\.git$/, '');
}

function buildPbxproj(config: IosProjectConfig): string {
  const m = config.moduleName;
  const swiftFiles: Array<{ rel: string; group: string }> = [
    { rel: `${m}App.swift`, group: 'module' },
    { rel: 'ContentView.swift', group: 'module' },
    { rel: 'Views/ItemDetailView.swift', group: 'Views' },
    { rel: 'Components/ItemRowView.swift', group: 'Components' },
    { rel: 'Models/Item.swift', group: 'Models' },
    { rel: 'ViewModels/ItemListViewModel.swift', group: 'ViewModels' }
  ];
  const fileName = (rel: string): string => rel.split('/').pop()!;

  const ids = {
    project: pid('project'),
    target: pid('target'),
    mainGroup: pid('group:main'),
    moduleGroup: pid('group:module'),
    productsGroup: pid('group:products'),
    viewsGroup: pid('group:Views'),
    componentsGroup: pid('group:Components'),
    modelsGroup: pid('group:Models'),
    viewModelsGroup: pid('group:ViewModels'),
    appRef: pid('ref:app'),
    assetsRef: pid('ref:assets'),
    infoRef: pid('ref:infoplist'),
    assetsBuild: pid('build:assets'),
    sourcesPhase: pid('phase:sources'),
    frameworksPhase: pid('phase:frameworks'),
    resourcesPhase: pid('phase:resources'),
    projectConfigList: pid('cfglist:project'),
    targetConfigList: pid('cfglist:target'),
    projectDebug: pid('cfg:project:debug'),
    projectRelease: pid('cfg:project:release'),
    targetDebug: pid('cfg:target:debug'),
    targetRelease: pid('cfg:target:release')
  };
  const fileRefId = (rel: string): string => pid(`ref:${rel}`);
  const buildFileId = (rel: string): string => pid(`build:${rel}`);
  const pkgRefId = (product: string): string => pid(`pkgref:${product}`);
  const pkgDepId = (product: string): string => pid(`pkgdep:${product}`);
  const pkgBuildId = (product: string): string => pid(`pkgbuild:${product}`);

  const groupIdFor = (group: string): string =>
    group === 'module' ? ids.moduleGroup : group === 'Views' ? ids.viewsGroup : group === 'Components' ? ids.componentsGroup : group === 'Models' ? ids.modelsGroup : ids.viewModelsGroup;

  const out: string[] = [];
  out.push('// !$*UTF8*$!');
  out.push('{');
  out.push('\tarchiveVersion = 1;');
  out.push('\tclasses = {');
  out.push('\t};');
  out.push('\tobjectVersion = 56;');
  out.push('\tobjects = {');
  out.push('');

  // PBXBuildFile
  out.push('/* Begin PBXBuildFile section */');
  for (const f of swiftFiles) {
    out.push(`\t\t${buildFileId(f.rel)} /* ${fileName(f.rel)} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRefId(f.rel)} /* ${fileName(f.rel)} */; };`);
  }
  out.push(`\t\t${ids.assetsBuild} /* Assets.xcassets in Resources */ = {isa = PBXBuildFile; fileRef = ${ids.assetsRef} /* Assets.xcassets */; };`);
  for (const dep of config.dependencies) {
    out.push(`\t\t${pkgBuildId(dep.product)} /* ${dep.product} in Frameworks */ = {isa = PBXBuildFile; productRef = ${pkgDepId(dep.product)} /* ${dep.product} */; };`);
  }
  out.push('/* End PBXBuildFile section */');
  out.push('');

  // PBXFileReference
  out.push('/* Begin PBXFileReference section */');
  for (const f of swiftFiles) {
    out.push(`\t\t${fileRefId(f.rel)} /* ${fileName(f.rel)} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${fileName(f.rel)}; sourceTree = "<group>"; };`);
  }
  out.push(`\t\t${ids.assetsRef} /* Assets.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; };`);
  out.push(`\t\t${ids.infoRef} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };`);
  out.push(`\t\t${ids.appRef} /* ${m}.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = ${m}.app; sourceTree = BUILT_PRODUCTS_DIR; };`);
  out.push('/* End PBXFileReference section */');
  out.push('');

  // PBXFrameworksBuildPhase
  out.push('/* Begin PBXFrameworksBuildPhase section */');
  out.push(`\t\t${ids.frameworksPhase} /* Frameworks */ = {`);
  out.push('\t\t\tisa = PBXFrameworksBuildPhase;');
  out.push('\t\t\tbuildActionMask = 2147483647;');
  out.push('\t\t\tfiles = (');
  for (const dep of config.dependencies) out.push(`\t\t\t\t${pkgBuildId(dep.product)} /* ${dep.product} in Frameworks */,`);
  out.push('\t\t\t);');
  out.push('\t\t\trunOnlyForDeploymentPostprocessing = 0;');
  out.push('\t\t};');
  out.push('/* End PBXFrameworksBuildPhase section */');
  out.push('');

  // PBXGroup
  const groupBlock = (id: string, name: string | null, path: string | null, children: string[]): void => {
    out.push(`\t\t${id} = {`);
    out.push('\t\t\tisa = PBXGroup;');
    out.push('\t\t\tchildren = (');
    for (const c of children) out.push(`\t\t\t\t${c},`);
    out.push('\t\t\t);');
    if (name) out.push(`\t\t\tname = ${name};`);
    if (path) out.push(`\t\t\tpath = ${path};`);
    out.push('\t\t\tsourceTree = "<group>";');
    out.push('\t\t};');
  };
  out.push('/* Begin PBXGroup section */');
  groupBlock(ids.mainGroup, null, null, [
    `${ids.moduleGroup} /* ${m} */`,
    `${ids.productsGroup} /* Products */`
  ]);
  groupBlock(ids.moduleGroup, m, m, [
    `${fileRefId(`${m}App.swift`)} /* ${m}App.swift */`,
    `${fileRefId('ContentView.swift')} /* ContentView.swift */`,
    `${ids.viewsGroup} /* Views */`,
    `${ids.componentsGroup} /* Components */`,
    `${ids.modelsGroup} /* Models */`,
    `${ids.viewModelsGroup} /* ViewModels */`,
    `${ids.assetsRef} /* Assets.xcassets */`,
    `${ids.infoRef} /* Info.plist */`
  ]);
  groupBlock(ids.viewsGroup, 'Views', 'Views', [`${fileRefId('Views/ItemDetailView.swift')} /* ItemDetailView.swift */`]);
  groupBlock(ids.componentsGroup, 'Components', 'Components', [`${fileRefId('Components/ItemRowView.swift')} /* ItemRowView.swift */`]);
  groupBlock(ids.modelsGroup, 'Models', 'Models', [`${fileRefId('Models/Item.swift')} /* Item.swift */`]);
  groupBlock(ids.viewModelsGroup, 'ViewModels', 'ViewModels', [`${fileRefId('ViewModels/ItemListViewModel.swift')} /* ItemListViewModel.swift */`]);
  groupBlock(ids.productsGroup, 'Products', null, [`${ids.appRef} /* ${m}.app */`]);
  out.push('/* End PBXGroup section */');
  out.push('');

  // PBXNativeTarget
  out.push('/* Begin PBXNativeTarget section */');
  out.push(`\t\t${ids.target} /* ${m} */ = {`);
  out.push('\t\t\tisa = PBXNativeTarget;');
  out.push(`\t\t\tbuildConfigurationList = ${ids.targetConfigList} /* Build configuration list for PBXNativeTarget "${m}" */;`);
  out.push('\t\t\tbuildPhases = (');
  out.push(`\t\t\t\t${ids.sourcesPhase} /* Sources */,`);
  out.push(`\t\t\t\t${ids.frameworksPhase} /* Frameworks */,`);
  out.push(`\t\t\t\t${ids.resourcesPhase} /* Resources */,`);
  out.push('\t\t\t);');
  out.push('\t\t\tbuildRules = (');
  out.push('\t\t\t);');
  out.push('\t\t\tdependencies = (');
  out.push('\t\t\t);');
  out.push(`\t\t\tname = ${m};`);
  if (config.dependencies.length) {
    out.push('\t\t\tpackageProductDependencies = (');
    for (const dep of config.dependencies) out.push(`\t\t\t\t${pkgDepId(dep.product)} /* ${dep.product} */,`);
    out.push('\t\t\t);');
  }
  out.push(`\t\t\tproductName = ${m};`);
  out.push(`\t\t\tproductReference = ${ids.appRef} /* ${m}.app */;`);
  out.push('\t\t\tproductType = "com.apple.product-type.application";');
  out.push('\t\t};');
  out.push('/* End PBXNativeTarget section */');
  out.push('');

  // PBXProject
  out.push('/* Begin PBXProject section */');
  out.push(`\t\t${ids.project} /* Project object */ = {`);
  out.push('\t\t\tisa = PBXProject;');
  out.push('\t\t\tattributes = {');
  out.push('\t\t\t\tBuildIndependentTargetsInParallel = 1;');
  out.push('\t\t\t\tLastSwiftUpdateCheck = 1520;');
  out.push('\t\t\t\tLastUpgradeCheck = 1520;');
  out.push('\t\t\t\tTargetAttributes = {');
  out.push(`\t\t\t\t\t${ids.target} = {`);
  out.push('\t\t\t\t\t\tCreatedOnToolsVersion = 15.2;');
  out.push('\t\t\t\t\t};');
  out.push('\t\t\t\t};');
  out.push('\t\t\t};');
  out.push(`\t\t\tbuildConfigurationList = ${ids.projectConfigList} /* Build configuration list for PBXProject "${m}" */;`);
  out.push('\t\t\tcompatibilityVersion = "Xcode 14.0";');
  out.push('\t\t\tdevelopmentRegion = en;');
  out.push('\t\t\thasScannedForEncodings = 0;');
  out.push('\t\t\tknownRegions = (');
  out.push('\t\t\t\ten,');
  out.push('\t\t\t\tBase,');
  out.push('\t\t\t);');
  out.push(`\t\t\tmainGroup = ${ids.mainGroup};`);
  if (config.dependencies.length) {
    out.push('\t\t\tpackageReferences = (');
    for (const dep of config.dependencies) {
      out.push(`\t\t\t\t${pkgRefId(dep.product)} /* XCRemoteSwiftPackageReference "${packageNameFromUrl(dep.url)}" */,`);
    }
    out.push('\t\t\t);');
  }
  out.push(`\t\t\tproductRefGroup = ${ids.productsGroup} /* Products */;`);
  out.push('\t\t\tprojectDirPath = "";');
  out.push('\t\t\tprojectRoot = "";');
  out.push('\t\t\ttargets = (');
  out.push(`\t\t\t\t${ids.target} /* ${m} */,`);
  out.push('\t\t\t);');
  out.push('\t\t};');
  out.push('/* End PBXProject section */');
  out.push('');

  // PBXResourcesBuildPhase
  out.push('/* Begin PBXResourcesBuildPhase section */');
  out.push(`\t\t${ids.resourcesPhase} /* Resources */ = {`);
  out.push('\t\t\tisa = PBXResourcesBuildPhase;');
  out.push('\t\t\tbuildActionMask = 2147483647;');
  out.push('\t\t\tfiles = (');
  out.push(`\t\t\t\t${ids.assetsBuild} /* Assets.xcassets in Resources */,`);
  out.push('\t\t\t);');
  out.push('\t\t\trunOnlyForDeploymentPostprocessing = 0;');
  out.push('\t\t};');
  out.push('/* End PBXResourcesBuildPhase section */');
  out.push('');

  // PBXSourcesBuildPhase
  out.push('/* Begin PBXSourcesBuildPhase section */');
  out.push(`\t\t${ids.sourcesPhase} /* Sources */ = {`);
  out.push('\t\t\tisa = PBXSourcesBuildPhase;');
  out.push('\t\t\tbuildActionMask = 2147483647;');
  out.push('\t\t\tfiles = (');
  for (const f of swiftFiles) out.push(`\t\t\t\t${buildFileId(f.rel)} /* ${fileName(f.rel)} in Sources */,`);
  out.push('\t\t\t);');
  out.push('\t\t\trunOnlyForDeploymentPostprocessing = 0;');
  out.push('\t\t};');
  out.push('/* End PBXSourcesBuildPhase section */');
  out.push('');

  // XCBuildConfiguration
  const projectSettings = (debug: boolean): string[] => [
    '\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;',
    '\t\t\t\tCLANG_ANALYZER_NONNULL = YES;',
    '\t\t\t\tCLANG_ENABLE_MODULES = YES;',
    '\t\t\t\tCLANG_ENABLE_OBJC_ARC = YES;',
    debug ? '\t\t\t\tCOPY_PHASE_STRIP = NO;' : '\t\t\t\tCOPY_PHASE_STRIP = YES;',
    debug ? '\t\t\t\tDEBUG_INFORMATION_FORMAT = dwarf;' : '\t\t\t\tDEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";',
    '\t\t\t\tENABLE_STRICT_OBJC_MSGSEND = YES;',
    debug ? '\t\t\t\tENABLE_TESTABILITY = YES;' : '',
    '\t\t\t\tGCC_C_LANGUAGE_STANDARD = gnu17;',
    debug ? '\t\t\t\tGCC_OPTIMIZATION_LEVEL = 0;' : '',
    '\t\t\t\tGCC_WARN_ABOUT_RETURN_TYPE = YES_ERROR;',
    '\t\t\t\tGCC_WARN_UNINITIALIZED_AUTOS = YES_AGGRESSIVE;',
    `\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = ${config.deploymentTarget};`,
    '\t\t\t\tLOCALIZATION_PREFERS_STRING_CATALOGS = YES;',
    '\t\t\t\tMTL_FAST_MATH = YES;',
    debug ? '\t\t\t\tONLY_ACTIVE_ARCH = YES;' : '',
    debug ? '\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG $(inherited)";' : '\t\t\t\tSWIFT_COMPILATION_MODE = wholemodule;',
    debug ? '\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-Onone";' : '',
    debug ? '' : '\t\t\t\tVALIDATE_PRODUCT = YES;'
  ].filter(Boolean);
  const targetSettings = (): string[] => [
    '\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;',
    '\t\t\t\tASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor;',
    '\t\t\t\tCODE_SIGN_STYLE = Automatic;',
    `\t\t\t\tCURRENT_PROJECT_VERSION = ${config.buildNumber};`,
    config.teamId ? `\t\t\t\tDEVELOPMENT_TEAM = ${config.teamId};` : '\t\t\t\tDEVELOPMENT_TEAM = "";',
    '\t\t\t\tGENERATE_INFOPLIST_FILE = NO;',
    `\t\t\t\tINFOPLIST_FILE = ${m}/Info.plist;`,
    `\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = ${config.deploymentTarget};`,
    '\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (',
    '\t\t\t\t\t"$(inherited)",',
    '\t\t\t\t\t"@executable_path/Frameworks",',
    '\t\t\t\t);',
    `\t\t\t\tMARKETING_VERSION = ${config.marketingVersion};`,
    `\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${config.bundleId};`,
    '\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";',
    '\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;',
    `\t\t\t\tSWIFT_VERSION = ${IosProjectGenerator.swiftLanguageMode(config.swiftVersion)};`,
    '\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";'
  ];
  const configBlock = (id: string, name: string, settings: string[]): void => {
    out.push(`\t\t${id} /* ${name} */ = {`);
    out.push('\t\t\tisa = XCBuildConfiguration;');
    out.push('\t\t\tbuildSettings = {');
    out.push(...settings);
    out.push('\t\t\t};');
    out.push(`\t\t\tname = ${name};`);
    out.push('\t\t};');
  };
  out.push('/* Begin XCBuildConfiguration section */');
  configBlock(ids.projectDebug, 'Debug', projectSettings(true));
  configBlock(ids.projectRelease, 'Release', projectSettings(false));
  configBlock(ids.targetDebug, 'Debug', targetSettings());
  configBlock(ids.targetRelease, 'Release', targetSettings());
  out.push('/* End XCBuildConfiguration section */');
  out.push('');

  // XCConfigurationList
  const listBlock = (id: string, ownerLabel: string, debugId: string, releaseId: string): void => {
    out.push(`\t\t${id} /* Build configuration list for ${ownerLabel} */ = {`);
    out.push('\t\t\tisa = XCConfigurationList;');
    out.push('\t\t\tbuildConfigurations = (');
    out.push(`\t\t\t\t${debugId} /* Debug */,`);
    out.push(`\t\t\t\t${releaseId} /* Release */,`);
    out.push('\t\t\t);');
    out.push('\t\t\tdefaultConfigurationIsVisible = 0;');
    out.push('\t\t\tdefaultConfigurationName = Release;');
    out.push('\t\t};');
  };
  out.push('/* Begin XCConfigurationList section */');
  listBlock(ids.projectConfigList, `PBXProject "${m}"`, ids.projectDebug, ids.projectRelease);
  listBlock(ids.targetConfigList, `PBXNativeTarget "${m}"`, ids.targetDebug, ids.targetRelease);
  out.push('/* End XCConfigurationList section */');

  if (config.dependencies.length) {
    out.push('');
    out.push('/* Begin XCRemoteSwiftPackageReference section */');
    for (const dep of config.dependencies) {
      out.push(`\t\t${pkgRefId(dep.product)} /* XCRemoteSwiftPackageReference "${packageNameFromUrl(dep.url)}" */ = {`);
      out.push('\t\t\tisa = XCRemoteSwiftPackageReference;');
      out.push(`\t\t\trepositoryURL = "${dep.url}";`);
      out.push(`\t\t\trequirement = ${requirementPbx(dep)};`);
      out.push('\t\t};');
    }
    out.push('/* End XCRemoteSwiftPackageReference section */');
    out.push('');
    out.push('/* Begin XCSwiftPackageProductDependency section */');
    for (const dep of config.dependencies) {
      out.push(`\t\t${pkgDepId(dep.product)} /* ${dep.product} */ = {`);
      out.push('\t\t\tisa = XCSwiftPackageProductDependency;');
      out.push(`\t\t\tpackage = ${pkgRefId(dep.product)} /* XCRemoteSwiftPackageReference "${packageNameFromUrl(dep.url)}" */;`);
      out.push(`\t\t\tproductName = ${dep.product};`);
      out.push('\t\t};');
    }
    out.push('/* End XCSwiftPackageProductDependency section */');
  }

  out.push('\t};');
  out.push(`\trootObject = ${ids.project} /* Project object */;`);
  out.push('}');
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Swift sources (SwiftUI, iOS 16-compatible APIs only)
// ---------------------------------------------------------------------------

function appSwift(config: IosProjectConfig): string {
  const m = config.moduleName;
  return `//
//  ${m}App.swift
//  ${m}
//
//  Generated by SquadForge Phase 25 (Native iOS Engine).
//

import SwiftUI

@main
struct ${m}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`;
}

function contentViewSwift(config: IosProjectConfig): string {
  return `//
//  ContentView.swift
//  ${config.moduleName}
//
//  Generated by SquadForge Phase 25 (Native iOS Engine).
//

import SwiftUI

struct ContentView: View {
    @StateObject private var viewModel = ItemListViewModel()

    var body: some View {
        NavigationStack {
            List(viewModel.items) { item in
                NavigationLink {
                    ItemDetailView(item: item)
                } label: {
                    ItemRowView(item: item)
                }
            }
            .navigationTitle("${config.appName}")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        viewModel.addSample()
                    } label: {
                        Label("Add", systemImage: "plus")
                    }
                }
            }
        }
    }
}

#Preview {
    ContentView()
}
`;
}

function detailViewSwift(): string {
  return `//
//  ItemDetailView.swift
//  Generated by SquadForge Phase 25 (Native iOS Engine).
//

import SwiftUI

struct ItemDetailView: View {
    let item: Item

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: item.symbolName)
                .font(.system(size: 56))
                .foregroundStyle(Color.accentColor)
            Text(item.title)
                .font(.title2.bold())
            Text(item.subtitle)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding()
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    NavigationStack {
        ItemDetailView(item: Item.samples[0])
    }
}
`;
}

function rowViewSwift(): string {
  return `//
//  ItemRowView.swift
//  Generated by SquadForge Phase 25 (Native iOS Engine).
//

import SwiftUI

/// Reusable list row component.
struct ItemRowView: View {
    let item: Item

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: item.symbolName)
                .font(.title3)
                .foregroundStyle(Color.accentColor)
                .frame(width: 32, height: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.headline)
                Text(item.subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
    }
}

#Preview {
    ItemRowView(item: Item.samples[0])
}
`;
}

function itemSwift(): string {
  return `//
//  Item.swift
//  Generated by SquadForge Phase 25 (Native iOS Engine).
//

import Foundation

struct Item: Identifiable, Hashable {
    let id: UUID
    var title: String
    var subtitle: String
    var symbolName: String

    init(id: UUID = UUID(), title: String, subtitle: String, symbolName: String) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.symbolName = symbolName
    }

    static let samples: [Item] = [
        Item(title: "Welcome", subtitle: "Your first item, generated by SquadForge.", symbolName: "sparkles"),
        Item(title: "Design", subtitle: "Edit the views in the Views and Components groups.", symbolName: "paintpalette.fill"),
        Item(title: "Ship it", subtitle: "Build with Xcode on macOS and distribute via the App Store.", symbolName: "paperplane.fill")
    ]
}
`;
}

function viewModelSwift(): string {
  return `//
//  ItemListViewModel.swift
//  Generated by SquadForge Phase 25 (Native iOS Engine).
//

import Foundation

@MainActor
final class ItemListViewModel: ObservableObject {
    @Published private(set) var items: [Item] = Item.samples

    func addSample() {
        items.append(
            Item(
                title: "Item \\(items.count + 1)",
                subtitle: "Added at runtime from the toolbar button.",
                symbolName: "star.fill"
            )
        )
    }
}
`;
}

// ---------------------------------------------------------------------------
// Info.plist / colorset / README
// ---------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function infoPlist(config: IosProjectConfig): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>CFBundleDevelopmentRegion</key>',
    '\t<string>$(DEVELOPMENT_LANGUAGE)</string>',
    '\t<key>CFBundleDisplayName</key>',
    `\t<string>${xmlEscape(config.appName)}</string>`,
    '\t<key>CFBundleExecutable</key>',
    '\t<string>$(EXECUTABLE_NAME)</string>',
    '\t<key>CFBundleIdentifier</key>',
    '\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>',
    '\t<key>CFBundleInfoDictionaryVersion</key>',
    '\t<string>6.0</string>',
    '\t<key>CFBundleName</key>',
    '\t<string>$(PRODUCT_NAME)</string>',
    '\t<key>CFBundlePackageType</key>',
    '\t<string>APPL</string>',
    '\t<key>CFBundleShortVersionString</key>',
    '\t<string>$(MARKETING_VERSION)</string>',
    '\t<key>CFBundleVersion</key>',
    '\t<string>$(CURRENT_PROJECT_VERSION)</string>',
    '\t<key>LSRequiresIPhoneOS</key>',
    '\t<true/>',
    '\t<key>UIApplicationSceneManifest</key>',
    '\t<dict>',
    '\t\t<key>UIApplicationSupportsMultipleScenes</key>',
    '\t\t<false/>',
    '\t</dict>',
    '\t<key>UIApplicationSupportsIndirectInputEvents</key>',
    '\t<true/>'
  ];
  const usageText: Record<string, string> = {
    camera: `${config.appName} uses the camera so you can capture photos in the app.`,
    photoLibrary: `${config.appName} accesses your photo library so you can pick images in the app.`,
    microphone: `${config.appName} uses the microphone so you can record audio in the app.`,
    locationWhenInUse: `${config.appName} uses your location while the app is open to show nearby content.`,
    faceId: `${config.appName} uses Face ID to unlock protected content.`
  };
  for (const perm of config.permissions) {
    const key = IOS_PERMISSION_PLIST_KEYS[perm];
    if (!key) continue; // notifications: runtime-only, no plist key
    lines.push(`\t<key>${key}</key>`);
    lines.push(`\t<string>${xmlEscape(usageText[perm])}</string>`);
  }
  lines.push('</dict>');
  lines.push('</plist>');
  return lines.join('\n') + '\n';
}

function accentColorset(config: IosProjectConfig): string {
  const hex = config.accentColorHex.replace('#', '');
  const comp = (i: number): string => `0x${hex.slice(i, i + 2).toUpperCase()}`;
  return (
    JSON.stringify(
      {
        colors: [
          {
            color: {
              'color-space': 'srgb',
              components: { alpha: '1.000', blue: comp(4), green: comp(2), red: comp(0) }
            },
            idiom: 'universal'
          }
        ],
        info: { author: 'xcode', version: 1 }
      },
      null,
      2
    ) + '\n'
  );
}

function readme(config: IosProjectConfig): string {
  const deps = config.dependencies.length
    ? config.dependencies.map((d) => `- ${d.product} — ${d.url} (${d.requirement.kind})`).join('\n')
    : '- None. Add packages in Xcode via File > Add Package Dependencies.';
  const perms = config.permissions.length ? config.permissions.join(', ') : 'none';
  return `# ${config.appName} (iOS)

Generated by SquadForge Phase 25 — Native iOS Development Engine.

- **Bundle ID:** ${config.bundleId}
- **Module:** ${config.moduleName}
- **Version:** ${config.marketingVersion} (${config.buildNumber})
- **Deployment target:** iOS ${config.deploymentTarget}
- **Swift:** ${config.swiftVersion} (language mode ${IosProjectGenerator.swiftLanguageMode(config.swiftVersion)})
- **Permissions:** ${perms}

## Structure

- \`${config.moduleName}App.swift\` — @main app entry (SwiftUI lifecycle)
- \`ContentView.swift\` — root NavigationStack list
- \`Views/\` — screens, \`Components/\` — reusable rows, \`Models/\` — data, \`ViewModels/\` — MVVM state
- \`Assets.xcassets\` — AppIcon (generated 1024×1024 PNG) + AccentColor
- \`Info.plist\` — app configuration incl. permission usage descriptions

## Swift Package Manager dependencies

${deps}

## Building

Native iOS builds require **macOS with Xcode** — they cannot be
produced on Linux or Windows. Open \`${config.moduleName}.xcodeproj\`
in Xcode, or from a terminal:

\`\`\`sh
xcodebuild -project ${config.moduleName}.xcodeproj -scheme ${config.moduleName} \\
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
\`\`\`

An IPA for distribution additionally requires an Apple Developer
team, a signing certificate, and a provisioning profile, all managed
by Xcode on the Mac — SquadForge never stores certificates or keys.
`;
}
