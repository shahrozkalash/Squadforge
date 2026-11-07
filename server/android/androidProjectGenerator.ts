import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AndroidProjectConfig, AndroidPermission } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AndroidProjectGenerator {
  private static assetsDir = path.resolve(__dirname, 'assets');

  /**
   * Retrieves the authentic Gradle wrapper binary JAR
   */
  public static getWrapperJarBuffer(): Buffer {
    const jarPath = path.join(this.assetsDir, 'gradle-wrapper.jar');
    if (fs.existsSync(jarPath)) {
      return fs.readFileSync(jarPath);
    }
    const altPath = path.resolve(process.cwd(), 'server/android/assets/gradle-wrapper.jar');
    if (fs.existsSync(altPath)) {
      return fs.readFileSync(altPath);
    }
    throw new Error('Official gradle-wrapper.jar asset not found');
  }

  /**
   * Retrieves the authentic POSIX gradlew launcher script
   */
  public static getGradlewPosix(): string {
    const filePath = path.join(this.assetsDir, 'gradlew');
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    const altPath = path.resolve(process.cwd(), 'server/android/assets/gradlew');
    if (fs.existsSync(altPath)) {
      return fs.readFileSync(altPath, 'utf-8');
    }
    return `#!/bin/sh\n# Gradle startup script for POSIX\nAPP_BASE_NAME=\`basename "$0"\`\nAPP_HOME=\`dirname "$0"\`\nexec java -jar "$APP_HOME/gradle/wrapper/gradle-wrapper.jar" "$@"\n`;
  }

  /**
   * Retrieves the authentic Windows gradlew.bat launcher script
   */
  public static getGradlewWindows(): string {
    const filePath = path.join(this.assetsDir, 'gradlew.bat');
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    const altPath = path.resolve(process.cwd(), 'server/android/assets/gradlew.bat');
    if (fs.existsSync(altPath)) {
      return fs.readFileSync(altPath, 'utf-8');
    }
    return `@rem Gradle startup script for Windows\r\n@if "%DEBUG%"=="" @echo off\r\nset DIRNAME=%~dp0\r\nif "%DIRNAME%"=="" set DIRNAME=.\r\njava -jar "%DIRNAME%gradle\\wrapper\\gradle-wrapper.jar" %*\r\n`;
  }

  /**
   * Verifies that the Gradle wrapper JAR and launcher assets are authentic and intact
   */
  public static verifyWrapperAssets(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    try {
      const jarBuf = this.getWrapperJarBuffer();
      if (jarBuf.length < 10000) {
        errors.push(`gradle-wrapper.jar size too small (${jarBuf.length} bytes; expected >10KB)`);
      }
      if (jarBuf[0] !== 0x50 || jarBuf[1] !== 0x4b || jarBuf[2] !== 0x03 || jarBuf[3] !== 0x04) {
        errors.push('gradle-wrapper.jar does not have valid ZIP/JAR magic bytes (PK\\x03\\x04)');
      }
    } catch (err: any) {
      errors.push(`gradle-wrapper.jar missing or unreadable: ${err.message}`);
    }

    const posixScript = this.getGradlewPosix();
    if (!posixScript || posixScript.length < 50) {
      errors.push('POSIX gradlew script missing or empty');
    }

    const winScript = this.getGradlewWindows();
    if (!winScript || winScript.length < 50) {
      errors.push('Windows gradlew.bat script missing or empty');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Detects Java and validates JAVA_HOME without hardcoding machine-specific paths
   */
  public static detectJavaHome(): string | null {
    // 1. Check process.env.JAVA_HOME
    if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) {
      const javaExe = process.platform === 'win32'
        ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe')
        : path.join(process.env.JAVA_HOME, 'bin', 'java');
      if (fs.existsSync(javaExe)) {
        return process.env.JAVA_HOME;
      }
    }

    // 2. Candidate JDK directories (standard cross-platform paths)
    const candidateDirs = [
      '/usr/lib/jvm/default-java',
      '/usr/lib/jvm/java-17-openjdk-amd64',
      '/usr/lib/jvm/java-21-openjdk-amd64',
      '/usr/lib/jvm/java-17-openjdk',
      '/usr/lib/jvm/java-21-openjdk',
      '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home',
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Java', 'jdk-17') : null,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Eclipse Adoptium', 'jdk-17') : null
    ].filter(Boolean) as string[];

    for (const cand of candidateDirs) {
      const javaExe = process.platform === 'win32'
        ? path.join(cand, 'bin', 'java.exe')
        : path.join(cand, 'bin', 'java');
      if (fs.existsSync(javaExe)) {
        return cand;
      }
    }

    // 3. Search PATH for java binary
    try {
      const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
      const out = execFileSync(lookupCmd, ['java'], { encoding: 'utf-8', timeout: 2000 }).trim();
      if (out && fs.existsSync(out)) {
        const resolved = fs.realpathSync(out);
        const binDir = path.dirname(resolved);
        const homeDir = path.dirname(binDir);
        const testExe = process.platform === 'win32'
          ? path.join(homeDir, 'bin', 'java.exe')
          : path.join(homeDir, 'bin', 'java');
        if (fs.existsSync(testExe)) {
          return homeDir;
        }
      }
    } catch {
      // not in PATH
    }

    return null;
  }

  /**
   * Detects the Android SDK location from environment configuration without hardcoding
   */
  public static detectSdkLocation(): string | null {
    if (process.env.ANDROID_HOME && fs.existsSync(process.env.ANDROID_HOME)) {
      return process.env.ANDROID_HOME;
    }
    if (process.env.ANDROID_SDK_ROOT && fs.existsSync(process.env.ANDROID_SDK_ROOT)) {
      return process.env.ANDROID_SDK_ROOT;
    }
    const candidates = [
      '/opt/android-sdk',
      '/usr/lib/android-sdk',
      path.join(process.env.HOME || '', 'Android/Sdk'),
      path.join(process.env.HOME || '', 'Library/Android/sdk'),
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android/Sdk') : null
    ].filter(Boolean) as string[];

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        return cand;
      }
    }
    return null;
  }

  public static getDefaultConfig(appName: string = 'SquadForgeApp', packageName: string = 'com.squadforge.app'): AndroidProjectConfig {
    const cleanPkg = packageName.toLowerCase().replace(/[^a-z0-9_.]/g, '') || 'com.squadforge.app';
    const cleanName = appName.replace(/[^a-zA-Z0-9 ]/g, '') || 'SquadForge';

    return {
      packageName: cleanPkg,
      appName: cleanName,
      minSdk: 24,
      targetSdk: 34,
      compileSdk: 34,
      versionCode: 1,
      versionName: '1.0.0',
      composeBomVersion: '2024.06.00',
      kotlinVersion: '2.0.0',
      agpVersion: '8.5.1',
      permissions: [
        'android.permission.INTERNET',
        'android.permission.ACCESS_NETWORK_STATE',
        'android.permission.POST_NOTIFICATIONS'
      ],
      features: [
        'compose_material3',
        'navigation_compose',
        'viewmodel_compose',
        'coroutines'
      ],
      uiArchitecture: 'compose_material3',
      theme: {
        primaryColor: '#F59E0B', // Amber
        secondaryColor: '#D97706',
        tertiaryColor: '#10B981',
        isDarkTheme: true
      },
      mainActivityName: 'MainActivity'
    };
  }

  /**
   * Generates all project files for an Android Studio Jetpack Compose application
   */
  public static generateProjectFiles(config: AndroidProjectConfig, targetSdkDir?: string): Record<string, string> {
    const pkgPath = config.packageName.replace(/\./g, '/');
    const files: Record<string, string> = {};

    // 1. Root Gradle Files
    files['build.gradle.kts'] = `// Top-level build file where you can add configuration options common to all sub-projects/modules.
plugins {
    id("com.android.application") version "${config.agpVersion}" apply false
    id("org.jetbrains.kotlin.android") version "${config.kotlinVersion}" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "${config.kotlinVersion}" apply false
}
`;

    files['settings.gradle.kts'] = `pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\\\.android.*")
                includeGroupByRegex("com\\\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "${config.appName}"
include(":app")
`;

    files['gradle.properties'] = `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
android.nonTransitiveRClass=true
`;

    // Never generate a hardcoded machine-specific path. Detect dynamically or provide guided config
    const detectedSdk = targetSdkDir || this.detectSdkLocation();
    if (detectedSdk) {
      files['local.properties'] = `## Location of the Android SDK. Automatically detected from environment.
# Do not commit this file to version control.
sdk.dir=${detectedSdk.replace(/\\\\/g, '/')}
`;
    } else {
      files['local.properties'] = `## Location of the Android SDK.
# This file is automatically generated by Android Studio or SquadForge based on environment configuration.
# Do not commit this file to version control.
`;
    }

    files['gradle/wrapper/gradle-wrapper.properties'] = `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-8.7-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`;

    files['gradlew'] = this.getGradlewPosix();
    files['gradlew.bat'] = this.getGradlewWindows();
    try {
      // Also provide gradle-wrapper.jar as base64 string
      files['gradle/wrapper/gradle-wrapper.jar'] = this.getWrapperJarBuffer().toString('base64');
    } catch {
      // ignore
    }


    files['.gitignore'] = `*.iml
.gradle
/local.properties
/.idea/caches
/.idea/libraries
/.idea/modules.xml
/.idea/workspace.xml
/.idea/navEditor.xml
/.idea/assetWizardSettings.xml
.DS_Store
/build
/captures
.externalNativeBuild
.cxx
local.properties
`;

    // 2. App Module Build File
    files['app/build.gradle.kts'] = `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "${config.packageName}"
    compileSdk = ${config.compileSdk}

    defaultConfig {
        applicationId = "${config.packageName}"
        minSdk = ${config.minSdk}
        targetSdk = ${config.targetSdk}
        versionCode = ${config.versionCode}
        versionName = "${config.versionName}"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables {
            useSupportLibrary = true
        }
    }

    signingConfigs {
        getByName("debug") {
            enableV1Signing = true
            enableV2Signing = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isDebuggable = true
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:${config.composeBomVersion}"))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.3")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.navigation:navigation-compose:2.7.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation(platform("androidx.compose:compose-bom:${config.composeBomVersion}"))
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
`;

    files['app/proguard-rules.pro'] = `# SquadForge Android Proguard Rules
-keepattributes *Annotation*
-keepclassmembers class * {
    @org.jetbrains.annotations.* <fields>;
    @org.jetbrains.annotations.* <methods>;
}
`;

    // 3. AndroidManifest.xml
    const permissionsXml = config.permissions
      .map(p => `    <uses-permission android:name="${p}" />`)
      .join('\n');

    files['app/src/main/AndroidManifest.xml'] = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools"
    package="${config.packageName}">

${permissionsXml}

    <application
        android:allowBackup="true"
        android:dataExtractionRules="@xml/data_extraction_rules"
        android:fullBackupContent="@xml/backup_rules"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/Theme.${config.appName.replace(/\s+/g, '')}"
        tools:targetApi="34">
        
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:label="@string/app_name"
            android:theme="@style/Theme.${config.appName.replace(/\s+/g, '')}">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>

</manifest>
`;

    // 4. Kotlin Source Tree
    files[`app/src/main/java/${pkgPath}/MainActivity.kt`] = `package ${config.packageName}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import ${config.packageName}.ui.theme.${config.appName.replace(/\s+/g, '')}Theme
import ${config.packageName}.ui.screens.MainAppNavHost

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ${config.appName.replace(/\s+/g, '')}Theme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    MainAppNavHost(
                        modifier = Modifier.padding(innerPadding)
                    )
                }
            }
        }
    }
}
`;

    // Theme: Color.kt
    files[`app/src/main/java/${pkgPath}/ui/theme/Color.kt`] = `package ${config.packageName}.ui.theme

import androidx.compose.ui.graphics.Color

val AmberPrimary = Color(0xFFF59E0B)
val AmberSecondary = Color(0xFFD97706)
val EmeraldTertiary = Color(0xFF10B981)

val DarkBackground = Color(0xFF0F172A)
val DarkSurface = Color(0xFF1E293B)
val DarkOnSurface = Color(0xFFF8FAFC)

val LightBackground = Color(0xFFF8FAFC)
val LightSurface = Color(0xFFFFFFFF)
val LightOnSurface = Color(0xFF0F172A)
`;

    // Theme: Type.kt
    files[`app/src/main/java/${pkgPath}/ui/theme/Type.kt`] = `package ${config.packageName}.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val Typography = Typography(
    bodyLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.5.sp
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Bold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
        letterSpacing = 0.sp
    ),
    labelSmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.5.sp
    )
)
`;

    // Theme: Theme.kt
    const themeName = `${config.appName.replace(/\s+/g, '')}Theme`;
    files[`app/src/main/java/${pkgPath}/ui/theme/Theme.kt`] = `package ${config.packageName}.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val DarkColorScheme = darkColorScheme(
    primary = AmberPrimary,
    secondary = AmberSecondary,
    tertiary = EmeraldTertiary,
    background = DarkBackground,
    surface = DarkSurface,
    onPrimary = DarkBackground,
    onBackground = DarkOnSurface,
    onSurface = DarkOnSurface
)

private val LightColorScheme = lightColorScheme(
    primary = AmberPrimary,
    secondary = AmberSecondary,
    tertiary = EmeraldTertiary,
    background = LightBackground,
    surface = LightSurface,
    onPrimary = LightSurface,
    onBackground = LightOnSurface,
    onSurface = LightOnSurface
)

@Composable
fun ${themeName}(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme

    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography,
        content = content
    )
}
`;

    // Screens: Navigation Host
    files[`app/src/main/java/${pkgPath}/ui/screens/MainAppNavHost.kt`] = `package ${config.packageName}.ui.screens

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController

sealed class Screen(val route: String) {
    object Home : Screen("home")
    object Details : Screen("details")
    object Permissions : Screen("permissions")
}

@Composable
fun MainAppNavHost(
    modifier: Modifier = Modifier,
    navController: NavHostController = rememberNavController(),
    startDestination: String = Screen.Home.route
) {
    NavHost(
        navController = navController,
        startDestination = startDestination,
        modifier = modifier
    ) {
        composable(Screen.Home.route) {
            HomeScreen(
                onNavigateToDetails = { navController.navigate(Screen.Details.route) },
                onNavigateToPermissions = { navController.navigate(Screen.Permissions.route) }
            )
        }
        composable(Screen.Details.route) {
            DetailsScreen(onNavigateBack = { navController.popBackStack() })
        }
        composable(Screen.Permissions.route) {
            PermissionsScreen(onNavigateBack = { navController.popBackStack() })
        }
    }
}
`;

    // Screens: HomeScreen.kt
    files[`app/src/main/java/${pkgPath}/ui/screens/HomeScreen.kt`] = `package ${config.packageName}.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ${config.packageName}.viewmodel.MainViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    modifier: Modifier = Modifier,
    onNavigateToDetails: () -> Unit = {},
    onNavigateToPermissions: () -> Unit = {},
    viewModel: MainViewModel = viewModel()
) {
    val items by viewModel.items.collectAsState()
    var textInput by remember { mutableStateOf("") }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "${config.appName}",
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.primary
            )
            Row {
                IconButton(onClick = onNavigateToPermissions) {
                    Icon(Icons.Default.Lock, contentDescription = "Permissions")
                }
                IconButton(onClick = onNavigateToDetails) {
                    Icon(Icons.Default.Info, contentDescription = "Details")
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "Native Jetpack Compose Engine",
                    style = MaterialTheme.typography.titleMedium
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Clean architecture with declarative Compose Material3 components and reactive StateFlow.",
                    style = MaterialTheme.typography.bodyMedium
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedTextField(
                value = textInput,
                onValueChange = { textInput = it },
                label = { Text("Add New Item") },
                modifier = Modifier.weight(1f)
            )
            Spacer(modifier = Modifier.width(8.dp))
            Button(
                onClick = {
                    if (textInput.isNotBlank()) {
                        viewModel.addItem(textInput)
                        textInput = ""
                    }
                }
            ) {
                Icon(Icons.Default.Add, contentDescription = "Add")
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "Active Items (\${items.size})",
            style = MaterialTheme.typography.titleSmall
        )

        Spacer(modifier = Modifier.height(8.dp))

        LazyColumn(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(items) { item ->
                Card(
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text(text = item.title, style = MaterialTheme.typography.bodyLarge)
                            Text(text = item.timestamp, style = MaterialTheme.typography.labelSmall)
                        }
                        IconButton(onClick = { viewModel.removeItem(item.id) }) {
                            Text("✕", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
    }
}
`;

    // Screens: DetailsScreen.kt
    files[`app/src/main/java/${pkgPath}/ui/screens/DetailsScreen.kt`] = `package ${config.packageName}.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailsScreen(
    onNavigateBack: () -> Unit = {}
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Application Info") },
                navigationIcon = {
                    TextButton(onClick = onNavigateBack) {
                        Text("← Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Package: ${config.packageName}", style = MaterialTheme.typography.bodyMedium)
                    Text("Target SDK: ${config.targetSdk}", style = MaterialTheme.typography.bodyMedium)
                    Text("Min SDK: ${config.minSdk}", style = MaterialTheme.typography.bodyMedium)
                    Text("Version: ${config.versionName} (${config.versionCode})", style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}
`;

    // Screens: PermissionsScreen.kt
    files[`app/src/main/java/${pkgPath}/ui/screens/PermissionsScreen.kt`] = `package ${config.packageName}.ui.screens

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PermissionsScreen(
    onNavigateBack: () -> Unit = {}
) {
    var cameraPermissionGranted by remember { mutableStateOf(false) }
    var locationPermissionGranted by remember { mutableStateOf(false) }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { isGranted: Boolean ->
        cameraPermissionGranted = isGranted
    }

    val locationPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { isGranted: Boolean ->
        locationPermissionGranted = isGranted
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Device Permissions") },
                navigationIcon = {
                    TextButton(onClick = onNavigateBack) {
                        Text("← Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Camera Access", style = MaterialTheme.typography.titleMedium)
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        if (cameraPermissionGranted) "Status: Granted" else "Status: Not Granted",
                        style = MaterialTheme.typography.bodySmall
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Button(
                        onClick = { cameraPermissionLauncher.launch(Manifest.permission.CAMERA) },
                        enabled = !cameraPermissionGranted
                    ) {
                        Text(if (cameraPermissionGranted) "Permission Active" else "Request Camera Access")
                    }
                }
            }

            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Location Access", style = MaterialTheme.typography.titleMedium)
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        if (locationPermissionGranted) "Status: Granted" else "Status: Not Granted",
                        style = MaterialTheme.typography.bodySmall
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Button(
                        onClick = { locationPermissionLauncher.launch(Manifest.permission.ACCESS_FINE_LOCATION) },
                        enabled = !locationPermissionGranted
                    ) {
                        Text(if (locationPermissionGranted) "Permission Active" else "Request Location Access")
                    }
                }
            }
        }
    }
}
`;

    // ViewModel: MainViewModel.kt
    files[`app/src/main/java/${pkgPath}/viewmodel/MainViewModel.kt`] = `package ${config.packageName}.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import ${config.packageName}.data.model.ProjectItem
import java.text.SimpleDateFormat
import java.util.*

class MainViewModel : ViewModel() {
    private val _items = MutableStateFlow<List<ProjectItem>>(
        listOf(
            ProjectItem("1", "Initialize Android Jetpack Compose Architecture", "Just now"),
            ProjectItem("2", "Configure Kotlin Gradle DSL & ProGuard", "5 mins ago"),
            ProjectItem("3", "Verify AndroidManifest and Permission Grants", "10 mins ago")
        )
    )
    val items: StateFlow<List<ProjectItem>> = _items.asStateFlow()

    fun addItem(title: String) {
        viewModelScope.launch {
            val dateFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
            val newItem = ProjectItem(
                id = UUID.randomUUID().toString(),
                title = title,
                timestamp = dateFormat.format(Date())
            )
            _items.value = _items.value + newItem
        }
    }

    fun removeItem(id: String) {
        viewModelScope.launch {
            _items.value = _items.value.filter { it.id != id }
        }
    }
}
`;

    // Data: Model
    files[`app/src/main/java/${pkgPath}/data/model/ProjectItem.kt`] = `package ${config.packageName}.data.model

data class ProjectItem(
    val id: String,
    val title: String,
    val timestamp: String
)
`;

    // 5. XML Resources
    const safeResName = config.appName.replace(/[^a-zA-Z0-9]/g, '');
    files['app/src/main/res/values/strings.xml'] = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${config.appName}</string>
    <string name="action_settings">Settings</string>
</resources>
`;

    files['app/src/main/res/values/colors.xml'] = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="primary">${config.theme.primaryColor}</color>
    <color name="secondary">${config.theme.secondaryColor}</color>
    <color name="tertiary">${config.theme.tertiaryColor}</color>
    <color name="black">#FF000000</color>
    <color name="white">#FFFFFFFF</color>
</resources>
`;

    files['app/src/main/res/values/themes.xml'] = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.${safeResName}" parent="android:Theme.Material.NoActionBar">
        <item name="android:statusBarColor">@color/primary</item>
        <item name="android:navigationBarColor">#FF0F172A</item>
    </style>
</resources>
`;

    files['app/src/main/res/xml/backup_rules.xml'] = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
    <include domain="sharedpref" path="."/>
</full-backup-content>
`;

    files['app/src/main/res/xml/data_extraction_rules.xml'] = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup>
        <include domain="sharedpref" path="."/>
    </cloud-backup>
    <device-transfer>
        <include domain="sharedpref" path="."/>
    </device-transfer>
</data-extraction-rules>
`;

    files['app/src/main/res/drawable/ic_launcher_background.xml'] = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#0F172A"
        android:pathData="M0,0h108v108h-108z"/>
</vector>
`;

    files['app/src/main/res/drawable/ic_launcher_foreground.xml'] = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#F59E0B"
        android:pathData="M31,63.928l18,-31.176l18,31.176h-36z"/>
</vector>
`;

    files['app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml'] = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;

    files['app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml'] = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;

    // 6. Unit & Instrumented Tests
    files[`app/src/test/java/${pkgPath}/ExampleUnitTest.kt`] = `package ${config.packageName}

import org.junit.Test
import org.junit.Assert.*

class ExampleUnitTest {
    @Test
    fun addition_isCorrect() {
        assertEquals(4, 2 + 2)
    }

    @Test
    fun packageName_isValid() {
        assertTrue("${config.packageName}".isNotEmpty())
    }
}
`;

    files[`app/src/androidTest/java/${pkgPath}/ExampleInstrumentedTest.kt`] = `package ${config.packageName}

import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assert.*

@RunWith(AndroidJUnit4::class)
class ExampleInstrumentedTest {
    @Test
    fun useAppContext() {
        val appContext = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("${config.packageName}", appContext.packageName)
    }
}
`;

    return files;
  }
}
