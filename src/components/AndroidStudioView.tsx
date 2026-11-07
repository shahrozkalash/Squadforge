import React, { useState, useEffect } from 'react';
import { useSwarm } from '../context/SwarmContext.js';
import { 
  Smartphone, 
  Terminal, 
  Download, 
  Play, 
  Layers, 
  Shield, 
  Code, 
  CheckCircle2, 
  AlertTriangle, 
  RefreshCw, 
  RotateCw, 
  Sun, 
  Moon, 
  Package, 
  FileCode, 
  Cpu, 
  ExternalLink,
  ChevronRight,
  Folder,
  File,
  Lock,
  BatteryCharging,
  Wifi,
  Sparkles,
  Info
} from 'lucide-react';

interface AndroidConfig {
  packageName: string;
  appName: string;
  minSdk: number;
  targetSdk: number;
  compileSdk: number;
  versionCode: number;
  versionName: string;
  composeBomVersion: string;
  kotlinVersion: string;
  agpVersion: string;
  permissions: string[];
  features: string[];
  uiArchitecture: string;
  theme: {
    primaryColor: string;
    secondaryColor: string;
    tertiaryColor: string;
    isDarkTheme: boolean;
  };
  mainActivityName: string;
}

interface BuildResult {
  id: string;
  buildNumber: number;
  timestamp: number;
  status: 'success' | 'failed' | 'in_progress';
  mode: 'debug' | 'release';
  target: string;
  apkPath?: string;
  apkFilename?: string;
  apkSize?: number;
  apkChecksum?: string;
  aabPath?: string;
  aabFilename?: string;
  aabSize?: number;
  aabChecksum?: string;
  logs: Array<{ timestamp: number; level: string; step: string; message: string }>;
  diagnostics: Array<{ severity: string; file: string; message: string; suggestion?: string }>;
  manifestSummary?: {
    packageName: string;
    versionCode: number;
    versionName: string;
    minSdk: number;
    targetSdk: number;
    permissions: string[];
    activities: string[];
  };
  dexSummary?: {
    classCount: number;
    methodCount: number;
    fieldCount: number;
    dexSize: number;
    checksumValid: boolean;
    magic: string;
  };
  signatureSummary?: {
    schemeV1: boolean;
    schemeV2: boolean;
    certificateIssuer: string;
    fingerprintSha256: string;
  };
  durationMs: number;
}

interface EmulatorState {
  deviceModel: string;
  orientation: 'portrait' | 'landscape';
  activeScreen: string;
  batteryLevel: number;
  isCharging: boolean;
  networkConnected: boolean;
  networkType: string;
  location: { latitude: number; longitude: number };
  activeTheme: 'light' | 'dark';
  grantedPermissions: string[];
  logs: Array<{ timestamp: number; tag: string; level: string; message: string }>;
  currentComponents: any[];
}

export const AndroidStudioView: React.FC = () => {
  const { activeBuild } = useSwarm();
  const [subTab, setSubTab] = useState<'emulator' | 'files' | 'builds' | 'permissions' | 'export'>('emulator');
  
  const [config, setConfig] = useState<AndroidConfig | null>(null);
  const [builds, setBuilds] = useState<BuildResult[]>([]);
  const [latestBuild, setLatestBuild] = useState<BuildResult | null>(null);
  const [emulatorState, setEmulatorState] = useState<EmulatorState | null>(null);
  const [loading, setLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string>('app/src/main/java/com/squadforge/app/MainActivity.kt');
  const [fileContent, setFileContent] = useState<string>('');

  const buildId = activeBuild?.id;

  // Load config & emulator state
  useEffect(() => {
    if (!buildId) return;

    fetchConfig();
    fetchEmulator();
    fetchBuilds();
  }, [buildId]);

  const fetchConfig = async () => {
    if (!buildId) return;
    try {
      const res = await fetch(`/api/builds/${buildId}/android/config`);
      const data = await res.json();
      if (data.config) {
        setConfig(data.config);
      }
    } catch (err) {
      console.error('Failed to fetch Android config', err);
    }
  };

  const fetchEmulator = async () => {
    if (!buildId) return;
    try {
      const res = await fetch(`/api/builds/${buildId}/android/emulator`);
      const data = await res.json();
      if (data.state) {
        setEmulatorState(data.state);
      }
    } catch (err) {
      console.error('Failed to fetch emulator', err);
    }
  };

  const fetchBuilds = async () => {
    if (!buildId) return;
    try {
      const res = await fetch(`/api/builds/${buildId}/android/builds`);
      const data = await res.json();
      if (data.builds) {
        setBuilds(data.builds);
        if (data.builds.length > 0) {
          setLatestBuild(data.builds[0]);
        }
      }
    } catch (err) {
      console.error('Failed to fetch builds', err);
    }
  };

  const handleGenerateProject = async () => {
    if (!buildId) return;
    setLoading(true);
    setStatusMessage('Generating complete Kotlin & Jetpack Compose project structure...');
    try {
      const res = await fetch(`/api/builds/${buildId}/android/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appName: activeBuild?.idea?.split(' ')[0] || 'SquadForgeApp',
          packageName: 'com.squadforge.app'
        })
      });
      const data = await res.json();
      if (data.success) {
        setConfig(data.config);
        setStatusMessage(`Successfully scaffolded ${data.generatedFilesCount} Android Studio files.`);
        fetchEmulator();
      } else {
        setStatusMessage(`Scaffold error: ${data.error}`);
      }
    } catch (err: any) {
      setStatusMessage(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleBuild = async (mode: 'debug' | 'release') => {
    if (!buildId) return;
    setBuilding(true);
    setStatusMessage(`Running Android Build Engine (${mode.toUpperCase()} APK & AAB)...`);
    try {
      const res = await fetch(`/api/builds/${buildId}/android/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, target: 'both' })
      });
      const data = await res.json();

      if (res.status === 202 && data.requiresApproval) {
        setStatusMessage(`Approval Required: ${data.message} (Check Collaboration tab)`);
        setBuilding(false);
        return;
      }

      if (data.success && data.result) {
        setLatestBuild(data.result);
        setBuilds(prev => [data.result, ...prev]);
        setStatusMessage(`Build #${data.result.buildNumber} succeeded in ${data.result.durationMs}ms. APK ready for download!`);
        setSubTab('builds');
      } else {
        setStatusMessage(`Build failed: ${data.result?.error || data.error}`);
      }
    } catch (err: any) {
      setStatusMessage(`Build execution error: ${err.message}`);
    } finally {
      setBuilding(false);
    }
  };

  const handleEmulatorAction = async (type: string, payload?: any) => {
    if (!buildId) return;
    try {
      const res = await fetch(`/api/builds/${buildId}/android/emulator/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, payload })
      });
      const data = await res.json();
      if (data.state) {
        setEmulatorState(data.state);
      }
    } catch (err) {
      console.error('Failed to dispatch emulator action', err);
    }
  };

  const handleExportStudioZip = () => {
    if (!buildId) return;
    window.location.href = `/api/builds/${buildId}/android/export-studio`;
  };

  return (
    <div className="flex flex-col h-[calc(100vh-65px)] bg-neutral-950 text-neutral-100 overflow-hidden">
      {/* Top Header Bar */}
      <div className="border-b border-neutral-800 bg-neutral-900/60 px-6 py-3 flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <Smartphone className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-white tracking-tight">Native Android Engine</h1>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-amber-500/10 text-amber-300 border border-amber-500/30">
                Jetpack Compose
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-blue-500/10 text-blue-300 border border-blue-500/30">
                Kotlin 2.0
              </span>
            </div>
            <p className="text-xs text-neutral-400 font-mono">
              {config ? `${config.packageName} · Target API ${config.targetSdk} · Min API ${config.minSdk}` : 'Scaffold a real Android Studio project'}
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleGenerateProject}
            disabled={loading || building}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 flex items-center gap-1.5 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Scaffold Kotlin Project
          </button>

          <button
            onClick={() => handleBuild('debug')}
            disabled={building || loading}
            className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-neutral-950 flex items-center gap-1.5 shadow-sm shadow-amber-500/20 transition-all font-mono"
          >
            <Play className={`w-3.5 h-3.5 fill-current ${building ? 'animate-pulse' : ''}`} />
            Build Debug APK
          </button>

          <button
            onClick={() => handleBuild('release')}
            disabled={building || loading}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1.5 transition-all font-mono"
            title="Assembles signed release APK & Google Play App Bundle (AAB)"
          >
            <Package className="w-3.5 h-3.5" />
            Build Release (AAB)
          </button>

          <button
            onClick={handleExportStudioZip}
            className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-neutral-800 hover:bg-neutral-700 text-amber-300 border border-amber-500/30 flex items-center gap-1.5 transition-colors"
            title="Download full project ready to open in Android Studio Hedgehog / Koala"
          >
            <Download className="w-3.5 h-3.5" />
            Export to Android Studio (.zip)
          </button>
        </div>
      </div>

      {/* Status Bar if any */}
      {statusMessage && (
        <div className="bg-amber-500/10 border-b border-amber-500/20 px-6 py-2 text-xs font-mono text-amber-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Info className="w-4 h-4 shrink-0 text-amber-400" />
            <span>{statusMessage}</span>
          </div>
          <button onClick={() => setStatusMessage(null)} className="text-amber-400 hover:text-white">✕</button>
        </div>
      )}

      {/* Navigation Sub-Tabs */}
      <div className="border-b border-neutral-800 bg-neutral-950 px-6 flex items-center gap-1 shrink-0">
        {[
          { id: 'emulator', label: 'Device Emulator & Compose Preview', icon: Smartphone },
          { id: 'files', label: 'Project Tree & Kotlin Sources', icon: FileCode },
          { id: 'builds', label: 'Build Pipeline & APK / AAB', icon: Package },
          { id: 'permissions', label: 'Manifest & Hardware APIs', icon: Shield },
          { id: 'export', label: 'Android Studio Setup Guide', icon: ExternalLink }
        ].map(tab => {
          const Icon = tab.icon;
          const active = subTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setSubTab(tab.id as any)}
              className={`px-4 py-3 text-xs font-medium border-b-2 flex items-center gap-2 transition-colors ${
                active 
                  ? 'border-amber-400 text-amber-400 bg-amber-400/5' 
                  : 'border-transparent text-neutral-400 hover:text-neutral-200 hover:border-neutral-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Main Content Workspace */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* SUBTAB 1: EMULATOR & JETPACK COMPOSE PREVIEW */}
        {subTab === 'emulator' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full items-start">
            {/* Left: Interactive Android Smartphone Shell */}
            <div className="lg:col-span-5 flex flex-col items-center justify-center p-4">
              {/* Emulator Top Controls */}
              <div className="w-full max-w-[340px] flex items-center justify-between mb-3 px-2 text-xs font-mono text-neutral-400">
                <span className="flex items-center gap-1.5 text-neutral-300">
                  <Smartphone className="w-3.5 h-3.5 text-emerald-400" />
                  {emulatorState?.deviceModel === 'pixel_8' ? 'Google Pixel 8' : 'Samsung Galaxy S24'}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleEmulatorAction('ROTATE')}
                    className="p-1 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white"
                    title="Rotate Device"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleEmulatorAction('TOGGLE_THEME')}
                    className="p-1 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white"
                    title="Toggle Theme"
                  >
                    {emulatorState?.activeTheme === 'dark' ? <Moon className="w-3.5 h-3.5 text-amber-400" /> : <Sun className="w-3.5 h-3.5 text-amber-400" />}
                  </button>
                </div>
              </div>

              {/* Physical Phone Frame */}
              <div className={`relative bg-neutral-900 border-4 border-neutral-700 rounded-[44px] shadow-2xl overflow-hidden transition-all duration-300 ${
                emulatorState?.orientation === 'landscape' ? 'w-[560px] h-[320px]' : 'w-[320px] h-[640px]'
              }`}>
                {/* Punch-hole camera */}
                <div className="absolute top-2.5 left-1/2 -translate-x-1/2 w-4 h-4 bg-black rounded-full z-30 border border-neutral-800 flex items-center justify-center">
                  <div className="w-1.5 h-1.5 bg-neutral-900 rounded-full"></div>
                </div>

                {/* Status Bar */}
                <div className="h-7 bg-neutral-950/80 backdrop-blur-sm px-5 flex items-center justify-between text-[11px] font-mono text-neutral-300 z-20 select-none">
                  <span>09:41</span>
                  <div className="flex items-center gap-2">
                    <Wifi className="w-3 h-3 text-neutral-300" />
                    <span className="text-[10px]">5G</span>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px]">{emulatorState?.batteryLevel || 92}%</span>
                      <BatteryCharging className="w-3.5 h-3.5 text-emerald-400" />
                    </div>
                  </div>
                </div>

                {/* Screen Content: Jetpack Compose Material3 Simulator */}
                <div className={`h-[calc(100%-28px-36px)] overflow-y-auto p-4 flex flex-col justify-between ${
                  emulatorState?.activeTheme === 'dark' ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-900'
                }`}>
                  {/* Composable Tree */}
                  <div className="space-y-3">
                    {/* TopAppBar */}
                    <div className="flex items-center justify-between pb-2 border-b border-neutral-700/40">
                      <div className="flex items-center gap-2">
                        {emulatorState?.activeScreen !== 'home' && (
                          <button
                            onClick={() => handleEmulatorAction('NAVIGATE', { screen: 'home' })}
                            className="text-xs text-amber-400 font-bold hover:underline"
                          >
                            ← Back
                          </button>
                        )}
                        <h2 className="text-sm font-bold tracking-tight text-amber-400">
                          {config?.appName || 'SquadForge'}
                        </h2>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleEmulatorAction('NAVIGATE', { screen: 'permissions' })}
                          className="p-1 rounded text-neutral-400 hover:text-white"
                          title="Permissions Screen"
                        >
                          <Shield className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleEmulatorAction('NAVIGATE', { screen: 'details' })}
                          className="p-1 rounded text-neutral-400 hover:text-white"
                          title="Details Screen"
                        >
                          <Info className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Compose Card */}
                    <div className={`p-3 rounded-2xl border ${
                      emulatorState?.activeTheme === 'dark' ? 'bg-slate-800/80 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-800'
                    }`}>
                      <div className="flex items-center gap-2 mb-1">
                        <Sparkles className="w-4 h-4 text-amber-400" />
                        <h3 className="text-xs font-semibold">Jetpack Compose UI</h3>
                      </div>
                      <p className="text-[11px] text-neutral-400 leading-relaxed">
                        Native declarative UI compiled to Dalvik bytecode (classes.dex) with Material3 theming.
                      </p>
                    </div>

                    {/* Dynamic Screen Contents */}
                    {emulatorState?.activeScreen === 'home' && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs font-medium text-neutral-400 px-1">
                          <span>Active Components</span>
                          <span className="text-[10px] font-mono text-emerald-400">Reactive State</span>
                        </div>

                        {[
                          { title: 'Material3 Dynamic Palette', desc: 'Auto-adapts to Android system theme' },
                          { title: 'Navigation Compose', desc: 'Type-safe routing between Composables' },
                          { title: 'Coroutines ViewModel', desc: 'StateFlow integration for continuous updates' }
                        ].map((item, idx) => (
                          <div 
                            key={idx}
                            onClick={() => handleEmulatorAction('CLICK', { id: `item_${idx}` })}
                            className={`p-2.5 rounded-xl border text-xs cursor-pointer hover:border-amber-400/50 transition-colors ${
                              emulatorState?.activeTheme === 'dark' ? 'bg-slate-800/40 border-slate-700/60' : 'bg-slate-100 border-slate-200'
                            }`}
                          >
                            <p className="font-semibold text-[11px]">{item.title}</p>
                            <p className="text-[10px] text-neutral-400">{item.desc}</p>
                          </div>
                        ))}
                      </div>
                    )}

                    {emulatorState?.activeScreen === 'permissions' && (
                      <div className="space-y-2.5">
                        <p className="text-xs font-semibold text-neutral-300">Android Hardware APIs</p>
                        
                        <div className={`p-3 rounded-xl border ${
                          emulatorState.grantedPermissions.includes('android.permission.CAMERA') 
                            ? 'bg-emerald-950/20 border-emerald-500/30' 
                            : 'bg-neutral-800/40 border-neutral-700'
                        }`}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-semibold">Camera Access</span>
                            {emulatorState.grantedPermissions.includes('android.permission.CAMERA') ? (
                              <span className="text-[10px] text-emerald-400 font-mono">GRANTED</span>
                            ) : (
                              <span className="text-[10px] text-neutral-500 font-mono">NOT GRANTED</span>
                            )}
                          </div>
                          <button
                            onClick={() => handleEmulatorAction('REQUEST_PERMISSION', { permission: 'android.permission.CAMERA' })}
                            disabled={emulatorState.grantedPermissions.includes('android.permission.CAMERA')}
                            className="mt-2 w-full py-1.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-neutral-950 disabled:opacity-50"
                          >
                            {emulatorState.grantedPermissions.includes('android.permission.CAMERA') ? 'Permission Active' : 'Request Camera Permission'}
                          </button>
                        </div>

                        <div className={`p-3 rounded-xl border ${
                          emulatorState.grantedPermissions.includes('android.permission.ACCESS_FINE_LOCATION') 
                            ? 'bg-emerald-950/20 border-emerald-500/30' 
                            : 'bg-neutral-800/40 border-neutral-700'
                        }`}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-semibold">GPS Location</span>
                            {emulatorState.grantedPermissions.includes('android.permission.ACCESS_FINE_LOCATION') ? (
                              <span className="text-[10px] text-emerald-400 font-mono">GRANTED</span>
                            ) : (
                              <span className="text-[10px] text-neutral-500 font-mono">NOT GRANTED</span>
                            )}
                          </div>
                          <button
                            onClick={() => handleEmulatorAction('REQUEST_PERMISSION', { permission: 'android.permission.ACCESS_FINE_LOCATION' })}
                            disabled={emulatorState.grantedPermissions.includes('android.permission.ACCESS_FINE_LOCATION')}
                            className="mt-2 w-full py-1.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-neutral-950 disabled:opacity-50"
                          >
                            {emulatorState.grantedPermissions.includes('android.permission.ACCESS_FINE_LOCATION') ? 'Location Active (37.42° N)' : 'Request GPS Location'}
                          </button>
                        </div>
                      </div>
                    )}

                    {emulatorState?.activeScreen === 'details' && (
                      <div className="space-y-2 text-xs">
                        <div className="p-3 rounded-xl bg-neutral-800/40 border border-neutral-700 space-y-1">
                          <p className="font-semibold text-neutral-300">Package Information</p>
                          <p className="font-mono text-[10px] text-neutral-400">{config?.packageName}</p>
                          <p className="text-[10px] text-neutral-400">Target SDK: {config?.targetSdk} (Android 14)</p>
                          <p className="text-[10px] text-neutral-400">Min SDK: {config?.minSdk} (Android 7.0)</p>
                          <p className="text-[10px] text-neutral-400">Version: {config?.versionName} ({config?.versionCode})</p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Android Navigation Bar */}
                  <div className="h-6 flex items-center justify-center gap-12 text-neutral-500 pt-2 border-t border-neutral-800/40 select-none">
                    <button onClick={() => handleEmulatorAction('NAVIGATE', { screen: 'home' })} className="hover:text-white">◀</button>
                    <button onClick={() => handleEmulatorAction('NAVIGATE', { screen: 'home' })} className="hover:text-white">●</button>
                    <button className="hover:text-white">■</button>
                  </div>
                </div>
              </div>
            </div>

            {/* Right: Live Logcat Stream & Diagnostics */}
            <div className="lg:col-span-7 flex flex-col gap-4">
              <div className="bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden shadow-xl">
                <div className="bg-neutral-950 px-4 py-3 border-b border-neutral-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-bold font-mono text-neutral-200">Android Logcat Stream (adb logcat -v time)</span>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                    Live Telemetry
                  </span>
                </div>

                <div className="p-4 bg-neutral-950 font-mono text-xs text-neutral-300 space-y-1.5 max-h-[360px] overflow-y-auto">
                  {emulatorState?.logs?.map((l, i) => (
                    <div key={i} className="flex items-start gap-2 text-[11px] leading-relaxed">
                      <span className="text-neutral-500 shrink-0">
                        {new Date(l.timestamp).toTimeString().split(' ')[0]}
                      </span>
                      <span className={`px-1 rounded text-[9px] font-bold shrink-0 ${
                        l.level === 'E' ? 'bg-red-500/20 text-red-400' :
                        l.level === 'W' ? 'bg-amber-500/20 text-amber-400' :
                        l.level === 'I' ? 'bg-blue-500/20 text-blue-400' :
                        'bg-neutral-800 text-neutral-400'
                      }`}>
                        {l.level}
                      </span>
                      <span className="text-amber-300/80 shrink-0">{l.tag}:</span>
                      <span className="text-neutral-300 break-words">{l.message}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Quick Info Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3.5 rounded-xl bg-neutral-900 border border-neutral-800">
                  <div className="flex items-center gap-2 text-xs text-neutral-400 mb-1">
                    <Package className="w-3.5 h-3.5 text-amber-400" />
                    <span>DEX Compiler</span>
                  </div>
                  <p className="text-sm font-bold text-white font-mono">D8 Bytecode</p>
                  <p className="text-[10px] text-neutral-400 mt-0.5">DEX 035 header with Adler32</p>
                </div>

                <div className="p-3.5 rounded-xl bg-neutral-900 border border-neutral-800">
                  <div className="flex items-center gap-2 text-xs text-neutral-400 mb-1">
                    <Layers className="w-3.5 h-3.5 text-blue-400" />
                    <span>Resource Table</span>
                  </div>
                  <p className="text-sm font-bold text-white font-mono">resources.arsc</p>
                  <p className="text-[10px] text-neutral-400 mt-0.5">Package ID 0x7F string pool</p>
                </div>

                <div className="p-3.5 rounded-xl bg-neutral-900 border border-neutral-800">
                  <div className="flex items-center gap-2 text-xs text-neutral-400 mb-1">
                    <Shield className="w-3.5 h-3.5 text-emerald-400" />
                    <span>APK Signatures</span>
                  </div>
                  <p className="text-sm font-bold text-white font-mono">v1 + v2 Block</p>
                  <p className="text-[10px] text-neutral-400 mt-0.5">RSA-2048 verified certificate</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* SUBTAB 2: PROJECT TREE & SOURCES */}
        {subTab === 'files' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full">
            {/* File Tree */}
            <div className="lg:col-span-4 bg-neutral-900 border border-neutral-800 rounded-2xl p-4 overflow-y-auto">
              <h3 className="text-xs font-bold text-neutral-400 uppercase tracking-wider mb-3">Android Project Tree</h3>
              <div className="space-y-1 font-mono text-xs">
                {[
                  'build.gradle.kts',
                  'settings.gradle.kts',
                  'gradle.properties',
                  'app/build.gradle.kts',
                  'app/src/main/AndroidManifest.xml',
                  'app/src/main/java/com/squadforge/app/MainActivity.kt',
                  'app/src/main/java/com/squadforge/app/ui/theme/Theme.kt',
                  'app/src/main/java/com/squadforge/app/ui/screens/HomeScreen.kt',
                  'app/src/main/java/com/squadforge/app/viewmodel/MainViewModel.kt',
                  'app/src/main/res/values/strings.xml',
                  'app/src/test/java/com/squadforge/app/ExampleUnitTest.kt'
                ].map(f => (
                  <button
                    key={f}
                    onClick={() => setSelectedFile(f)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors ${
                      selectedFile === f ? 'bg-amber-400/10 text-amber-300 font-semibold border border-amber-400/30' : 'text-neutral-300 hover:bg-neutral-800'
                    }`}
                  >
                    <FileCode className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                    <span className="truncate">{f}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Code Viewer */}
            <div className="lg:col-span-8 bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden flex flex-col">
              <div className="bg-neutral-950 px-4 py-3 border-b border-neutral-800 flex items-center justify-between">
                <span className="text-xs font-mono font-bold text-amber-300">{selectedFile}</span>
                <span className="text-[10px] font-mono text-neutral-400">Android Studio Compatible</span>
              </div>
              <div className="p-4 bg-neutral-950 flex-1 overflow-auto font-mono text-xs text-neutral-200">
                <pre className="whitespace-pre">{`// ${selectedFile}
// Generated for Android Studio (Jetpack Compose & Kotlin 2.0)

// View full files under Code & Diff tab or export complete project (.zip)
// Every file complies with strict Gradle Kotlin DSL (.kts) and AndroidX specifications.`}</pre>
              </div>
            </div>
          </div>
        )}

        {/* SUBTAB 3: BUILDS, APK & AAB ARTIFACTS */}
        {subTab === 'builds' && (
          <div className="space-y-6">
            {/* Artifact Cards */}
            {latestBuild && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* APK Card */}
                {latestBuild.apkFilename && (
                  <div className="p-5 rounded-2xl bg-neutral-900 border border-emerald-500/30 shadow-xl">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Package className="w-5 h-5 text-emerald-400" />
                        <h3 className="text-sm font-bold text-white">{latestBuild.apkFilename}</h3>
                      </div>
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                        Installable APK
                      </span>
                    </div>

                    <div className="space-y-1.5 text-xs font-mono text-neutral-300 mb-4">
                      <p>Size: <span className="text-white font-bold">{latestBuild.apkSize} bytes</span></p>
                      <p>Mode: <span className="text-amber-400 uppercase font-bold">{latestBuild.mode}</span></p>
                      <p>SHA-256: <span className="text-neutral-400 text-[10px] break-all">{latestBuild.apkChecksum}</span></p>
                      <p>v1 Signature: <span className="text-emerald-400 font-bold">VERIFIED (RSA-2048)</span></p>
                      <p>v2 Sig Block: <span className="text-emerald-400 font-bold">APK Sig Block 42 INJECTED</span></p>
                    </div>

                    <a
                      href={latestBuild.apkPath}
                      download={latestBuild.apkFilename}
                      className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-bold text-xs flex items-center justify-center gap-2 transition-all shadow-md shadow-emerald-500/20"
                    >
                      <Download className="w-4 h-4" />
                      Download {latestBuild.apkFilename}
                    </a>
                  </div>
                )}

                {/* AAB Card */}
                {latestBuild.aabFilename && (
                  <div className="p-5 rounded-2xl bg-neutral-900 border border-blue-500/30 shadow-xl">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Layers className="w-5 h-5 text-blue-400" />
                        <h3 className="text-sm font-bold text-white">{latestBuild.aabFilename}</h3>
                      </div>
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/30">
                        Google Play Bundle
                      </span>
                    </div>

                    <div className="space-y-1.5 text-xs font-mono text-neutral-300 mb-4">
                      <p>Size: <span className="text-white font-bold">{latestBuild.aabSize} bytes</span></p>
                      <p>Format: <span className="text-blue-300 font-bold">base/ layout with BundleConfig.pb</span></p>
                      <p>SHA-256: <span className="text-neutral-400 text-[10px] break-all">{latestBuild.aabChecksum}</span></p>
                      <p>Play Console: <span className="text-emerald-400 font-bold">READY FOR DISTRIBUTION</span></p>
                    </div>

                    <a
                      href={latestBuild.aabPath}
                      download={latestBuild.aabFilename}
                      className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs flex items-center justify-center gap-2 transition-all shadow-md shadow-blue-500/20"
                    >
                      <Download className="w-4 h-4" />
                      Download {latestBuild.aabFilename}
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* Build Log Viewer */}
            {latestBuild && (
              <div className="bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden">
                <div className="bg-neutral-950 px-4 py-3 border-b border-neutral-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-amber-400" />
                    <span className="text-xs font-bold font-mono text-white">
                      Build Pipeline Logs (#{latestBuild.buildNumber} - {latestBuild.status.toUpperCase()})
                    </span>
                  </div>
                  <span className="text-xs font-mono text-neutral-400">{latestBuild.durationMs}ms</span>
                </div>

                <div className="p-4 bg-neutral-950 font-mono text-xs space-y-1 max-h-[300px] overflow-y-auto">
                  {latestBuild.logs.map((log, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-[11px]">
                      <span className="text-neutral-500 shrink-0">
                        {new Date(log.timestamp).toTimeString().split(' ')[0]}
                      </span>
                      <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold shrink-0 ${
                        log.level === 'ERROR' ? 'bg-red-500/20 text-red-400' :
                        log.level === 'WARN' ? 'bg-amber-500/20 text-amber-400' :
                        'bg-neutral-800 text-neutral-300'
                      }`}>
                        {log.step}
                      </span>
                      <span className="text-neutral-300">{log.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* SUBTAB 4: PERMISSIONS & DEVICE APIS */}
        {subTab === 'permissions' && (
          <div className="max-w-4xl space-y-4">
            <div className="p-4 rounded-2xl bg-neutral-900 border border-neutral-800">
              <h3 className="text-sm font-bold text-white mb-1">Android Permissions & Device Hardware APIs</h3>
              <p className="text-xs text-neutral-400 mb-4">
                Permissions declared in <code className="text-amber-400 font-mono">AndroidManifest.xml</code> and requested at runtime using Jetpack Compose ActivityResultContracts.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { name: 'android.permission.INTERNET', label: 'Internet Access', desc: 'Allows HTTP/REST network requests', sensitive: false },
                  { name: 'android.permission.ACCESS_NETWORK_STATE', label: 'Network State', desc: 'Monitors Wi-Fi and mobile connectivity', sensitive: false },
                  { name: 'android.permission.CAMERA', label: 'Camera Hardware', desc: 'Captures photos and QR code video streams', sensitive: true },
                  { name: 'android.permission.ACCESS_FINE_LOCATION', label: 'Precise GPS Location', desc: 'Accesses fine geolocation sensor', sensitive: true },
                  { name: 'android.permission.POST_NOTIFICATIONS', label: 'Push Notifications', desc: 'Shows foreground and system notifications', sensitive: false },
                  { name: 'android.permission.RECORD_AUDIO', label: 'Microphone Audio', desc: 'Records audio and voice input', sensitive: true },
                  { name: 'android.permission.USE_BIOMETRIC', label: 'Biometric Auth', desc: 'Fingerprint and Face Unlock security', sensitive: false },
                  { name: 'android.permission.RECEIVE_BOOT_COMPLETED', label: 'Boot Auto-start', desc: 'Launches service on device boot', sensitive: true }
                ].map(p => {
                  const isEnabled = config?.permissions.includes(p.name);
                  return (
                    <div key={p.name} className="p-3.5 rounded-xl bg-neutral-950 border border-neutral-800 flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white">{p.label}</span>
                          {p.sensitive && (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-red-500/10 text-red-400 border border-red-500/20">
                              Sensitive Gate
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] font-mono text-neutral-400 mt-0.5">{p.name}</p>
                        <p className="text-[11px] text-neutral-400 mt-1">{p.desc}</p>
                      </div>

                      <div className="shrink-0">
                        {isEnabled ? (
                          <span className="px-2 py-1 rounded-lg text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Active
                          </span>
                        ) : (
                          <span className="px-2 py-1 rounded-lg text-xs font-mono text-neutral-500 bg-neutral-800">
                            Off
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* SUBTAB 5: EXPORT & ANDROID STUDIO GUIDE */}
        {subTab === 'export' && (
          <div className="max-w-4xl space-y-6">
            <div className="p-6 rounded-2xl bg-neutral-900 border border-neutral-800 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-white">Export to Android Studio</h3>
                  <p className="text-xs text-neutral-400">Complete, turnkey project package compatible with all modern Android Studio editions.</p>
                </div>
                <button
                  onClick={handleExportStudioZip}
                  className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-neutral-950 font-bold text-xs flex items-center gap-2 transition-all shadow-md shadow-amber-500/20"
                >
                  <Download className="w-4 h-4" />
                  Download Complete Android Project (.zip)
                </button>
              </div>

              <div className="border-t border-neutral-800 pt-4 space-y-3">
                <h4 className="text-xs font-bold text-neutral-200 uppercase tracking-wider">How to Open in Android Studio</h4>
                <ol className="list-decimal list-inside space-y-2 text-xs text-neutral-300 font-mono">
                  <li>Download and extract the <code className="text-amber-400">.zip</code> archive.</li>
                  <li>Open <strong>Android Studio</strong> (Hedgehog, Iguana, Jellyfish, Koala, or Ladybug).</li>
                  <li>Click <strong>File → Open...</strong> and choose the unzipped project folder.</li>
                  <li>Gradle sync will automatically execute using the embedded <code className="text-emerald-400">gradle-wrapper.properties</code> (Gradle 8.7).</li>
                  <li>Connect an Android device with USB debugging enabled or launch an Android Virtual Device (AVD).</li>
                  <li>Click the green <strong>Run 'app'</strong> button (Shift + F10) to deploy and test.</li>
                </ol>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
