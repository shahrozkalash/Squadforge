/**
 * Phase 18: Desktop Development Engine — shared types.
 *
 * Windows was the first supported desktop target; the Linux target
 * (Avalonia UI) landed in Phase 36. The platform field is part of
 * every config so the macOS generator can still be added later
 * without changing the pipeline or routes.
 */

export type DesktopPlatform = 'windows' | 'linux' | 'macos';

export type DesktopUiFramework = 'winforms' | 'wpf' | 'avalonia';

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
  /**
   * Root directory harvested artifacts are copied into, under a
   * per-build subdirectory. Defaults to `<cwd>/.desktop_artifacts`.
   * Callers that report artifact paths of their own (the F6 desktop
   * environment adapter) pass their root so the reported paths are
   * the harvested ones — before Factory F11 the pipeline ignored
   * any other root and the adapter's custom-root paths pointed at
   * files that were never written there.
   */
  artifactsRoot?: string;
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

export interface ElfInspectionReport {
  isElfFile: boolean;
  /** '64-bit' or '32-bit' (ELFCLASS64 / ELFCLASS32). */
  elfClass?: string;
  /** 'little-endian' or 'big-endian' (ELFDATA2LSB / ELFDATA2MSB). */
  endianness?: string;
  /** Human-readable e_machine, e.g. 'x86-64'. */
  machine?: string;
  /** Human-readable e_type, e.g. 'DYN (shared object / PIE executable)'. */
  objectType?: string;
  errors: string[];
}
