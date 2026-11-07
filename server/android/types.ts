export type AndroidPermission =
  | 'android.permission.INTERNET'
  | 'android.permission.ACCESS_NETWORK_STATE'
  | 'android.permission.CAMERA'
  | 'android.permission.RECORD_AUDIO'
  | 'android.permission.ACCESS_FINE_LOCATION'
  | 'android.permission.ACCESS_COARSE_LOCATION'
  | 'android.permission.POST_NOTIFICATIONS'
  | 'android.permission.READ_MEDIA_IMAGES'
  | 'android.permission.READ_MEDIA_VIDEO'
  | 'android.permission.READ_MEDIA_AUDIO'
  | 'android.permission.VIBRATE'
  | 'android.permission.WAKE_LOCK'
  | 'android.permission.RECEIVE_BOOT_COMPLETED'
  | 'android.permission.USE_BIOMETRIC'
  | 'android.permission.BLUETOOTH'
  | 'android.permission.BLUETOOTH_CONNECT'
  | 'android.permission.BLUETOOTH_SCAN'
  | 'android.permission.SYSTEM_ALERT_WINDOW'
  | 'android.permission.FOREGROUND_SERVICE';

export const SENSITIVE_ANDROID_PERMISSIONS: AndroidPermission[] = [
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.RECORD_AUDIO',
  'android.permission.ACCESS_FINE_LOCATION'
];

export type AndroidFeature =
  | 'compose_material3'
  | 'navigation_compose'
  | 'viewmodel_compose'
  | 'coroutines'
  | 'room_database'
  | 'retrofit_networking'
  | 'coil_image_loading'
  | 'biometric_auth'
  | 'datastore_preferences';

export interface AndroidProjectConfig {
  packageName: string;
  appName: string;
  minSdk: number;
  targetSdk: number;
  compileSdk: number;
  versionCode: number;
  versionName: string;
  composeBomVersion: string;
  kotlinVersion: string;
  agpVersion: string; // Android Gradle Plugin version
  permissions: AndroidPermission[];
  features: AndroidFeature[];
  uiArchitecture: 'compose_material3' | 'compose_navigation';
  theme: {
    primaryColor: string;
    secondaryColor: string;
    tertiaryColor: string;
    isDarkTheme: boolean;
  };
  mainActivityName: string;
  applicationClass?: string;
}

export interface AndroidBuildLogEntry {
  timestamp: number;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  step: string;
  message: string;
}

export interface AndroidDiagnostic {
  severity: 'error' | 'warning' | 'info';
  file: string;
  line?: number;
  column?: number;
  message: string;
  ruleId?: string;
  suggestion?: string;
}

export interface AndroidBuildOptions {
  mode: 'debug' | 'release';
  target: 'apk' | 'aab' | 'both';
  signConfig?: {
    useDebugKey?: boolean;
    keyAlias?: string;
    keystorePassword?: string;
    keyPassword?: string;
  };
  runTests?: boolean;
  lintCheck?: boolean;
}

export interface AndroidManifestSummary {
  packageName: string;
  versionCode: number;
  versionName: string;
  minSdk: number;
  targetSdk: number;
  permissions: string[];
  activities: string[];
}

export interface AndroidDexSummary {
  classCount: number;
  methodCount: number;
  fieldCount: number;
  dexSize: number;
  checksumValid: boolean;
  magic: string;
  headerSha1: string;
}

export interface AndroidSignatureSummary {
  schemeV1: boolean;
  schemeV2: boolean;
  certificateIssuer: string;
  certificateSubject: string;
  validFrom: string;
  validTo: string;
  fingerprintSha256: string;
}

export interface AndroidBuildResult {
  id: string;
  buildId: string;
  buildNumber: number;
  timestamp: number;
  status: 'success' | 'failed' | 'in_progress';
  mode: 'debug' | 'release';
  target: 'apk' | 'aab' | 'both';
  apkPath?: string;
  apkFilename?: string;
  apkSize?: number;
  apkChecksum?: string;
  aabPath?: string;
  aabFilename?: string;
  aabSize?: number;
  aabChecksum?: string;
  logs: AndroidBuildLogEntry[];
  diagnostics: AndroidDiagnostic[];
  manifestSummary?: AndroidManifestSummary;
  dexSummary?: AndroidDexSummary;
  signatureSummary?: AndroidSignatureSummary;
  durationMs: number;
  error?: string;
}

export interface AndroidComposableNode {
  id: string;
  type:
    | 'Scaffold'
    | 'TopAppBar'
    | 'Text'
    | 'Button'
    | 'Card'
    | 'LazyColumn'
    | 'Item'
    | 'TextField'
    | 'Icon'
    | 'Switch'
    | 'PermissionBanner'
    | 'FloatingActionButton';
  props: Record<string, any>;
  children?: AndroidComposableNode[];
}

export interface AndroidEmulatorState {
  deviceModel: 'pixel_8' | 'galaxy_s24' | 'pixel_tablet';
  orientation: 'portrait' | 'landscape';
  activeScreen: string;
  batteryLevel: number;
  isCharging: boolean;
  networkConnected: boolean;
  networkType: 'WIFI' | '5G' | 'OFFLINE';
  location: { latitude: number; longitude: number };
  activeTheme: 'light' | 'dark';
  grantedPermissions: string[];
  logs: Array<{
    timestamp: number;
    tag: string;
    level: 'V' | 'D' | 'I' | 'W' | 'E';
    message: string;
  }>;
  currentComponents: AndroidComposableNode[];
}

export interface AndroidToolchainStatus {
  sdkFound: boolean;
  sdkPath?: string;
  adbFound: boolean;
  adbPath?: string;
  adbVersion?: string;
  emulatorFound: boolean;
  emulatorPath?: string;
  apksignerFound: boolean;
  apksignerPath?: string;
  bundletoolFound: boolean;
  bundletoolPath?: string;
  availableAvds: string[];
  connectedDevices: Array<{
    serial: string;
    state: string;
    model?: string;
    product?: string;
    isEmulator: boolean;
  }>;
}
