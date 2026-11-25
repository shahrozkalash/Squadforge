/**
 * Phase 18: Desktop Development Engine — shared types.
 *
 * Windows is the first supported desktop target. The platform field is
 * part of every config so Linux and macOS generators can be added later
 * without changing the pipeline or routes.
 */

export type DesktopPlatform = 'windows' | 'linux' | 'macos';

export type DesktopUiFramework = 'winforms' | 'wpf';

export interface DesktopProjectConfig {
  appName: string;
  /** Assembly / namespace-safe name (letters, digits, underscores). */
  assemblyName: string;
  platform: DesktopPlatform;
  uiFramework: DesktopUiFramework;
  /** .NET target framework moniker, e.g. net8.0-windows */
  targetFramework: string;
  dotnetSdkVersion: string;
  version: string;
  company: string;
  description: string;
  /** Request administrator execution level in the app manifest. */
  requireAdministrator: boolean;
}

export interface DesktopBuildOptions {
  configuration: 'Debug' | 'Release';
  /** Run `dotnet restore` before building (dependency management step). */
  restore: boolean;
}

export interface DesktopBuildLogEntry {
  timestamp: number;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  step: string;
  message: string;
}

export interface DesktopDiagnostic {
  severity: 'error' | 'warning' | 'info';
  file: string;
  message: string;
  suggestion?: string;
}

export interface DesktopArtifact {
  filename: string;
  kind: 'exe' | 'dll' | 'other';
  sizeBytes: number;
  sha256: string;
}

export interface DesktopBuildResult {
  id: string;
  buildId: string;
  timestamp: number;
  status: 'success' | 'failed';
  configuration: 'Debug' | 'Release';
  platform: DesktopPlatform;
  logs: DesktopBuildLogEntry[];
  diagnostics: DesktopDiagnostic[];
  artifacts: DesktopArtifact[];
  durationMs: number;
  error?: string;
}

export interface PeInspectionReport {
  isPeFile: boolean;
  machine?: string;
  subsystem?: string;
  isGuiApp?: boolean;
  sections?: number;
  errors: string[];
}
