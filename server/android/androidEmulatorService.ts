import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { 
  AndroidEmulatorState, 
  AndroidComposableNode, 
  AndroidProjectConfig,
  AndroidToolchainStatus 
} from './types.js';

export class AndroidEmulatorService {
  private static instance: AndroidEmulatorService | null = null;
  private statesByBuildId: Map<string, AndroidEmulatorState> = new Map();

  public static getInstance(): AndroidEmulatorService {
    if (!this.instance) {
      this.instance = new AndroidEmulatorService();
    }
    return this.instance;
  }

  private findExecutable(name: string): string | null {
    const standardPaths = [
      `/usr/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/opt/android-sdk/platform-tools/${name}`,
      `/opt/android-sdk/emulator/${name}`,
      `/opt/android-sdk/cmdline-tools/latest/bin/${name}`,
      `/usr/lib/android-sdk/platform-tools/${name}`
    ];
    for (const p of standardPaths) {
      if (fs.existsSync(p)) return p;
    }
    try {
      const out = execFileSync('which', [name], { encoding: 'utf-8', timeout: 2000 }).trim();
      if (out && fs.existsSync(out)) return out;
    } catch {
      // not found
    }
    return null;
  }

  /**
   * Detects the host Android SDK, ADB bridge, emulator installations, and connected devices
   */
  public async detectToolchain(): Promise<AndroidToolchainStatus> {
    const adbPath = this.findExecutable('adb');
    const emulatorPath = this.findExecutable('emulator');
    const apksignerPath = this.findExecutable('apksigner');
    const bundletoolPath = this.findExecutable('bundletool');

    let sdkPath: string | undefined;
    if (process.env.ANDROID_HOME && fs.existsSync(process.env.ANDROID_HOME)) {
      sdkPath = process.env.ANDROID_HOME;
    } else if (process.env.ANDROID_SDK_ROOT && fs.existsSync(process.env.ANDROID_SDK_ROOT)) {
      sdkPath = process.env.ANDROID_SDK_ROOT;
    } else if (fs.existsSync('/opt/android-sdk')) {
      sdkPath = '/opt/android-sdk';
    } else if (fs.existsSync('/usr/lib/android-sdk')) {
      sdkPath = '/usr/lib/android-sdk';
    }

    let adbVersion: string | undefined;
    if (adbPath) {
      try {
        const out = execFileSync(adbPath, ['version'], { encoding: 'utf-8', timeout: 3000 });
        const match = out.match(/Android Debug Bridge version ([^\r\n]+)/);
        adbVersion = match ? match[1] : out.trim().split('\n')[0];
      } catch {
        // ignore
      }
    }

    // List AVDs
    const availableAvds: string[] = [];
    const avdmanager = this.findExecutable('avdmanager');
    if (avdmanager) {
      try {
        const out = execFileSync(avdmanager, ['list', 'avd'], { encoding: 'utf-8', timeout: 4000 });
        const nameMatches = out.matchAll(/Name:\s*([^\r\n]+)/g);
        for (const m of nameMatches) {
          if (m[1]) availableAvds.push(m[1].trim());
        }
      } catch {
        // ignore
      }
    } else if (emulatorPath) {
      try {
        const out = execFileSync(emulatorPath, ['-list-avds'], { encoding: 'utf-8', timeout: 4000 });
        for (const line of out.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) availableAvds.push(trimmed);
        }
      } catch {
        // ignore
      }
    }

    // List connected devices via ADB
    const connectedDevices = await this.listConnectedDevices();

    return {
      sdkFound: Boolean(sdkPath),
      sdkPath,
      adbFound: Boolean(adbPath),
      adbPath: adbPath || undefined,
      adbVersion,
      emulatorFound: Boolean(emulatorPath),
      emulatorPath: emulatorPath || undefined,
      apksignerFound: Boolean(apksignerPath),
      apksignerPath: apksignerPath || undefined,
      bundletoolFound: Boolean(bundletoolPath),
      bundletoolPath: bundletoolPath || undefined,
      availableAvds,
      connectedDevices
    };
  }

  /**
   * Queries `adb devices -l` to find all currently connected physical devices or emulators
   */
  public async listConnectedDevices(): Promise<Array<{
    serial: string;
    state: string;
    model?: string;
    product?: string;
    isEmulator: boolean;
  }>> {
    const adbPath = this.findExecutable('adb');
    if (!adbPath) return [];

    return new Promise((resolve) => {
      execFile(adbPath, ['devices', '-l'], { timeout: 4000 }, (err, stdout) => {
        if (err || !stdout) {
          return resolve([]);
        }

        const lines = stdout.split('\n');
        const devices: Array<{ serial: string; state: string; model?: string; product?: string; isEmulator: boolean }> = [];

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('List of devices attached') || trimmed.startsWith('*')) {
            continue;
          }
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 2) {
            const serial = parts[0];
            const state = parts[1];
            const modelMatch = trimmed.match(/model:(\S+)/);
            const productMatch = trimmed.match(/product:(\S+)/);
            const isEmulator = serial.startsWith('emulator-');

            devices.push({
              serial,
              state,
              model: modelMatch ? modelMatch[1] : undefined,
              product: productMatch ? productMatch[1] : undefined,
              isEmulator
            });
          }
        }
        resolve(devices);
      });
    });
  }

  /**
   * Starts a genuine Android emulator instance using the host emulator binary
   */
  public async startEmulator(optionsOrAvd?: string | { avdName?: string; headless?: boolean }): Promise<{ success: boolean; pid?: number; message: string }> {
    const avdName = typeof optionsOrAvd === 'string' ? optionsOrAvd : (optionsOrAvd?.avdName || 'pixel_8');
    const headless = typeof optionsOrAvd === 'object' && optionsOrAvd !== null ? Boolean(optionsOrAvd.headless) : false;
    const emulatorPath = this.findExecutable('emulator');
    if (!emulatorPath) {
      return {
        success: false,
        message: 'Android emulator binary not found in system or SDK path.'
      };
    }

    try {
      const args = ['-avd', avdName, '-no-snapshot', '-no-boot-anim'];
      if (headless) {
        args.push('-no-window');
      }
      const child = spawn(emulatorPath, args, {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();

      return {
        success: true,
        pid: child.pid,
        message: `Started emulator instance for AVD "${avdName}" (PID: ${child.pid}).`
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to launch emulator: ${err.message}`
      };
    }
  }

  /**
   * Installs an APK onto a real device or running emulator via `adb install -r`
   */
  public async installApk(serial: string, apkPath: string): Promise<{ success: boolean; output: string }> {
    const adbPath = this.findExecutable('adb');
    if (!adbPath) {
      return { success: false, output: 'ADB executable not found.' };
    }
    if (!fs.existsSync(apkPath)) {
      return { success: false, output: `APK file not found at: ${apkPath}` };
    }

    return new Promise((resolve) => {
      execFile(adbPath, ['-s', serial, 'install', '-r', apkPath], { timeout: 60000 }, (err, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        if (err || output.includes('Failure')) {
          resolve({ success: false, output: output || err?.message || 'Install failed' });
        } else {
          resolve({ success: true, output: output.trim() || 'Success' });
        }
      });
    });
  }

  /**
   * Launches an installed Android application via `adb shell am start`
   */
  public async launchApp(serial: string, packageName: string, activityName: string = '.MainActivity'): Promise<{ success: boolean; output: string }> {
    const adbPath = this.findExecutable('adb');
    if (!adbPath) {
      return { success: false, output: 'ADB executable not found.' };
    }

    const component = `${packageName}/${activityName}`;
    return new Promise((resolve) => {
      execFile(adbPath, ['-s', serial, 'shell', 'am', 'start', '-n', component], { timeout: 15000 }, (err, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        if (err || output.includes('Error')) {
          resolve({ success: false, output: output || err?.message || 'Launch failed' });
        } else {
          resolve({ success: true, output: output.trim() });
        }
      });
    });
  }

  /**
   * Collects recent Logcat lines from a connected device/emulator via `adb logcat -d`
   */
  public async collectLogcat(
    serialOrOptions?: string | { deviceSerial?: string; lines?: number; filterTag?: string },
    maxLines: number = 100
  ): Promise<{ success: boolean; logs: string[] }> {
    let serial: string | undefined;
    let lines = maxLines;
    let filterTag: string | undefined;

    if (typeof serialOrOptions === 'object' && serialOrOptions !== null) {
      serial = serialOrOptions.deviceSerial;
      lines = serialOrOptions.lines ?? maxLines;
      filterTag = serialOrOptions.filterTag;
    } else if (typeof serialOrOptions === 'string') {
      serial = serialOrOptions;
    }

    const adbPath = this.findExecutable('adb');
    if (!adbPath) {
      return { success: false, logs: ['ADB executable not found.'] };
    }

    const args = serial
      ? ['-s', serial, 'logcat', '-d', '-v', 'time', '-t', String(lines)]
      : ['logcat', '-d', '-v', 'time', '-t', String(lines)];

    if (filterTag) {
      args.push('-s', filterTag);
    }

    return new Promise((resolve) => {
      execFile(adbPath, args, { timeout: 8000 }, (err, stdout) => {
        if (err || !stdout) {
          return resolve({ success: false, logs: [err?.message || 'Failed to read logcat'] });
        }
        const outLines = stdout.split('\n').filter(l => l.trim().length > 0);
        resolve({ success: true, logs: outLines });
      });
    });
  }

  // =========================================================================
  // BROWSER SIMULATOR ENGINE (Clearly labelled as Browser Simulator)
  // =========================================================================

  public getOrCreateState(buildId: string, config?: AndroidProjectConfig): AndroidEmulatorState {
    let state = this.statesByBuildId.get(buildId);
    if (!state) {
      const appName = config?.appName || 'SquadForge';
      state = {
        deviceModel: 'pixel_8',
        orientation: 'portrait',
        activeScreen: 'home',
        batteryLevel: 92,
        isCharging: false,
        networkConnected: true,
        networkType: 'WIFI',
        location: { latitude: 37.4220, longitude: -122.0841 }, // Mountain View, CA
        activeTheme: config?.theme.isDarkTheme ? 'dark' : 'light',
        grantedPermissions: config?.permissions.filter(p => !p.includes('CAMERA') && !p.includes('LOCATION')) || [
          'android.permission.INTERNET',
          'android.permission.ACCESS_NETWORK_STATE'
        ],
        logs: [
          { timestamp: Date.now() - 5000, tag: 'ActivityManager', level: 'I', message: `Start proc 1420:${config?.packageName || 'com.squadforge.app'}/u0a120 for activity .MainActivity` },
          { timestamp: Date.now() - 4000, tag: 'AppCompatDelegate', level: 'D', message: 'Checking for metadata in manifest...' },
          { timestamp: Date.now() - 3000, tag: 'ComposeEngine', level: 'I', message: 'Jetpack Compose runtime initialized successfully with Material3 Theme.' },
          { timestamp: Date.now() - 1500, tag: 'NavHost', level: 'D', message: 'Navigating to start destination: Screen.Home ("home")' }
        ],
        currentComponents: this.buildComposeHierarchy(appName, 'home', config?.theme.primaryColor || '#F59E0B')
      };
      this.statesByBuildId.set(buildId, state);
    }
    return state;
  }

  public dispatchAction(
    buildId: string, 
    action: {
      type: 'CLICK' | 'NAVIGATE' | 'REQUEST_PERMISSION' | 'ROTATE' | 'TOGGLE_THEME' | 'UPDATE_DEVICE';
      payload?: any;
    },
    config?: AndroidProjectConfig
  ): AndroidEmulatorState {
    const state = this.getOrCreateState(buildId, config);
    const now = Date.now();

    switch (action.type) {
      case 'NAVIGATE': {
        const targetScreen = action.payload?.screen || 'home';
        state.activeScreen = targetScreen;
        state.logs.push({
          timestamp: now,
          tag: 'NavigationController',
          level: 'I',
          message: `Navigated to screen: ${targetScreen}`
        });
        state.currentComponents = this.buildComposeHierarchy(
          config?.appName || 'SquadForge', 
          targetScreen, 
          config?.theme.primaryColor || '#F59E0B',
          state.grantedPermissions
        );
        break;
      }

      case 'REQUEST_PERMISSION': {
        const permission = action.payload?.permission;
        if (permission && !state.grantedPermissions.includes(permission)) {
          state.grantedPermissions.push(permission);
          state.logs.push({
            timestamp: now,
            tag: 'GrantPermissionsActivity',
            level: 'I',
            message: `User granted runtime permission: ${permission}`
          });
          state.currentComponents = this.buildComposeHierarchy(
            config?.appName || 'SquadForge',
            state.activeScreen,
            config?.theme.primaryColor || '#F59E0B',
            state.grantedPermissions
          );
        }
        break;
      }

      case 'ROTATE': {
        state.orientation = state.orientation === 'portrait' ? 'landscape' : 'portrait';
        state.logs.push({
          timestamp: now,
          tag: 'WindowManager',
          level: 'D',
          message: `Screen orientation changed to: ${state.orientation}`
        });
        break;
      }

      case 'TOGGLE_THEME': {
        state.activeTheme = state.activeTheme === 'dark' ? 'light' : 'dark';
        state.logs.push({
          timestamp: now,
          tag: 'MaterialTheme',
          level: 'D',
          message: `Dynamic theme toggled: ${state.activeTheme}`
        });
        break;
      }

      case 'UPDATE_DEVICE': {
        if (action.payload?.deviceModel) state.deviceModel = action.payload.deviceModel;
        if (action.payload?.batteryLevel !== undefined) state.batteryLevel = action.payload.batteryLevel;
        if (action.payload?.networkType) state.networkType = action.payload.networkType;
        if (action.payload?.location) state.location = action.payload.location;
        break;
      }

      case 'CLICK': {
        const componentId = action.payload?.id;
        state.logs.push({
          timestamp: now,
          tag: 'ViewRootImpl',
          level: 'V',
          message: `InputEvent: MotionEvent.ACTION_UP at Composable Node #${componentId}`
        });
        break;
      }
    }

    return state;
  }

  private buildComposeHierarchy(
    appName: string, 
    screen: string, 
    primaryColor: string,
    grantedPermissions: string[] = []
  ): AndroidComposableNode[] {
    if (screen === 'details') {
      return [
        {
          id: 'scaffold_root',
          type: 'Scaffold',
          props: { primaryColor },
          children: [
            {
              id: 'top_bar',
              type: 'TopAppBar',
              props: { title: 'Application Details', showBackButton: true }
            },
            {
              id: 'card_info',
              type: 'Card',
              props: {
                title: `${appName} Architecture`,
                subtitle: 'Jetpack Compose Material3 + Kotlin Coroutines'
              },
              children: [
                { id: 'txt_target', type: 'Text', props: { text: 'Target SDK: Android 14 (API 34)' } },
                { id: 'txt_min', type: 'Text', props: { text: 'Min SDK: Android 7.0 (API 24)' } },
                { id: 'txt_comp', type: 'Text', props: { text: 'Compose Compiler 2.0 with BOM 2024.06.00' } }
              ]
            }
          ]
        }
      ];
    }

    if (screen === 'permissions') {
      const hasCamera = grantedPermissions.includes('android.permission.CAMERA');
      const hasLocation = grantedPermissions.includes('android.permission.ACCESS_FINE_LOCATION');

      return [
        {
          id: 'scaffold_root',
          type: 'Scaffold',
          props: { primaryColor },
          children: [
            {
              id: 'top_bar',
              type: 'TopAppBar',
              props: { title: 'Android Device Permissions', showBackButton: true }
            },
            {
              id: 'perm_camera',
              type: 'PermissionBanner',
              props: {
                permission: 'android.permission.CAMERA',
                title: 'Camera Hardware API',
                description: 'Required to capture photos and scan QR barcodes.',
                isGranted: hasCamera
              }
            },
            {
              id: 'perm_location',
              type: 'PermissionBanner',
              props: {
                permission: 'android.permission.ACCESS_FINE_LOCATION',
                title: 'Precise GPS Location API',
                description: 'Required for real-time location mapping and telemetry.',
                isGranted: hasLocation
              }
            }
          ]
        }
      ];
    }

    // Default: Home Screen
    return [
      {
        id: 'scaffold_root',
        type: 'Scaffold',
        props: { primaryColor },
        children: [
          {
            id: 'top_bar',
            type: 'TopAppBar',
            props: { title: appName, showActions: true }
          },
          {
            id: 'card_hero',
            type: 'Card',
            props: {
              title: 'Native Android Engine',
              subtitle: 'Kotlin + Jetpack Compose Material3'
            },
            children: [
              {
                id: 'txt_hero_desc',
                type: 'Text',
                props: { text: 'Declarative composable UI running natively on Dalvik/ART.' }
              }
            ]
          },
          {
            id: 'lazy_column_items',
            type: 'LazyColumn',
            props: { title: 'Active Modules' },
            children: [
              {
                id: 'item_1',
                type: 'Item',
                props: {
                  title: 'Jetpack Compose Navigation',
                  subtitle: 'Type-safe routes with Compose NavHost'
                }
              },
              {
                id: 'item_2',
                type: 'Item',
                props: {
                  title: 'Material3 Dynamic Color Scheme',
                  subtitle: 'Adaptive light and dark theme palette'
                }
              },
              {
                id: 'item_3',
                type: 'Item',
                props: {
                  title: 'Kotlin Coroutines & StateFlow',
                  subtitle: 'Structured concurrency in AndroidX ViewModel'
                }
              }
            ]
          },
          {
            id: 'fab_add',
            type: 'FloatingActionButton',
            props: { icon: 'Add' }
          }
        ]
      }
    ];
  }
}
