import { 
  AndroidEmulatorState, 
  AndroidComposableNode, 
  AndroidProjectConfig 
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
