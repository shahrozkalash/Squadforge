/**
 * Phase 25 — Native iOS Development Engine types.
 *
 * Mirrors the Phase 17 Android type conventions. Signing material is
 * NEVER part of a project config: no certificates, private keys, or
 * provisioning profiles are stored in SquadForge — a build may name a
 * development team ID (not a secret) and Xcode/macOS handles the rest.
 */

export type IosPermission =
  | 'camera'
  | 'photoLibrary'
  | 'microphone'
  | 'locationWhenInUse'
  | 'faceId'
  | 'notifications';

/** Info.plist usage-description key for a permission (null = runtime-only). */
export const IOS_PERMISSION_PLIST_KEYS: Record<IosPermission, string | null> = {
  camera: 'NSCameraUsageDescription',
  photoLibrary: 'NSPhotoLibraryUsageDescription',
  microphone: 'NSMicrophoneUsageDescription',
  locationWhenInUse: 'NSLocationWhenInUseUsageDescription',
  faceId: 'NSFaceIDUsageDescription',
  notifications: null // requested at runtime via UNUserNotificationCenter; no plist key exists
};

export interface SpmDependency {
  /** HTTPS git URL of the package repository (no embedded credentials). */
  url: string;
  /** Product name to link into the app target. */
  product: string;
  requirement:
    | { kind: 'upToNextMajor'; minimumVersion: string }
    | { kind: 'exact'; version: string }
    | { kind: 'branch'; branch: string }
    | { kind: 'revision'; revision: string };
}

export interface IosProjectConfig {
  appName: string;
  /** Swift module / product name, derived from appName (sanitized identifier). */
  moduleName: string;
  bundleId: string;
  marketingVersion: string;
  buildNumber: string;
  deploymentTarget: string; // e.g. '16.0'
  swiftVersion: string; // e.g. '5.9'
  /** Optional Apple development team ID (10 chars; an identifier, not a credential). */
  teamId?: string;
  permissions: IosPermission[];
  dependencies: SpmDependency[];
  /** Accent color as #RRGGBB — drives the AccentColor colorset and generated icon. */
  accentColorHex: string;
}

export interface IosDiagnostic {
  severity: 'error' | 'warning' | 'info';
  file: string;
  line?: number;
  column?: number;
  message: string;
}

export interface IosBuildLogEntry {
  timestamp: number;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  step: string;
  message: string;
}

export interface IosArtifact {
  filename: string;
  kind: 'app' | 'ipa';
  sizeBytes: number;
  /** SHA-256 of the app's main executable (for .app bundles) or of the .ipa file. */
  sha256: string;
}

export interface IosEnvironment {
  platform: string;
  isMac: boolean;
  xcodeVersion: string | null;
  /** Human-readable reason when builds cannot run here. */
  reason: string | null;
}

export type IosBuildStatus = 'success' | 'failed' | 'environment-unavailable';

export interface IosBuildResult {
  buildId: string;
  status: IosBuildStatus;
  durationMs: number;
  destination: string;
  environment: IosEnvironment;
  logs: IosBuildLogEntry[];
  diagnostics: IosDiagnostic[];
  artifacts: IosArtifact[];
  /** Set when IPA export was requested but could not be performed. */
  ipaNote: string | null;
  error: string | null;
  /**
   * Tail of the raw xcodebuild output when a step fails without
   * producing parseable `path:line: error:` diagnostics, so the
   * actual failure is visible to callers instead of being lost with
   * the ephemeral build workspace.
   */
  outputTail?: string;
}

export interface IosValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
