/**
 * Phase 34 — Native Android Video Editor generator ("ClipForge").
 *
 * Generates a genuine, native Android Studio project (Kotlin +
 * Jetpack Compose) implementing the SquadForge video editor on
 * device: photo-picker media import, a multitrack timeline with the
 * same project model and edit operations as the server engine
 * (Phases 20/26–31), ExoPlayer preview, Media3 Transformer export
 * with progress and cancellation, on-device project persistence with
 * recovery, and an optional connection to the SquadForge
 * video-editor API (Phase 31 project load/save).
 *
 * It builds on the Phase 17 generator: the base project comes from
 * AndroidProjectGenerator, then the app module gains Media3
 * dependencies and the editor sources replace the starter activity.
 * No WebView is involved anywhere.
 *
 * Libraries (all Apache License 2.0):
 * - AndroidX Media3 1.6.1 (exoplayer, transformer, effect, ui) —
 *   Google's media stack; playback and export are genuine Media3.
 * - Jetpack Compose / Material 3 (from the Phase 17 base project).
 * - org.json (built into Android; the JSON artifact is a test-only
 *   dependency so the editor's pure-Kotlin operations can run in
 *   local JVM unit tests).
 */
import { AndroidProjectGenerator } from './androidProjectGenerator.js';
import { AndroidProjectConfig } from './types.js';

export const MEDIA3_VERSION = '1.6.1';

export const VIDEO_EDITOR_DEPENDENCIES = [
  `implementation("androidx.media3:media3-exoplayer:${MEDIA3_VERSION}")`,
  `implementation("androidx.media3:media3-transformer:${MEDIA3_VERSION}")`,
  `implementation("androidx.media3:media3-effect:${MEDIA3_VERSION}")`,
  `implementation("androidx.media3:media3-ui:${MEDIA3_VERSION}")`,
  'testImplementation("org.json:json:20230618")',
  'androidTestImplementation("androidx.test.ext:junit:1.2.1")',
  'androidTestImplementation("androidx.test:runner:1.6.2")'
];

export function getVideoEditorConfig(
  appName: string = 'ClipForge',
  packageName: string = 'com.squadforge.clipforge'
): AndroidProjectConfig {
  const base = AndroidProjectGenerator.getDefaultConfig(appName, packageName);
  return {
    ...base,
    // Media3 1.6.1's AAR metadata requires compileSdk 35 — proven by
    // the first genuine CI run (45649089150), where the Phase 17
    // default of 34 failed at :app:checkDebugAarMetadata because
    // media3-datasource / media3-database 1.6.1 demand a newer API
    // level. targetSdk stays 34.
    compileSdk: 35,
    // The photo picker and the system document picker grant access
    // to exactly what the user picks, so the editor needs no storage
    // permission at all. INTERNET is only for the optional SquadForge
    // API connection.
    permissions: ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE'],
    features: ['compose_material3', 'navigation_compose', 'viewmodel_compose', 'coroutines']
  };
}

function packagePath(config: AndroidProjectConfig): string {
  return config.packageName.replace(/\./g, '/');
}

/**
 * Generate the complete ClipForge project: the Phase 17 base project
 * with Media3 dependencies and the native editor sources.
 */
export function generateVideoEditorProject(
  config: AndroidProjectConfig = getVideoEditorConfig()
): Record<string, string> {
  const files = AndroidProjectGenerator.generateProjectFiles(config);
  const pkg = config.packageName;
  const root = `app/src/main/java/${packagePath(config)}`;

  // AGP 8.5.1 predates compileSdk 35 and warns about it; the warning
  // is harmless but noisy, so the generated project suppresses it.
  if (files['gradle.properties'] && !files['gradle.properties'].includes('android.suppressUnsupportedCompileSdk')) {
    files['gradle.properties'] += 'android.suppressUnsupportedCompileSdk=35\n';
  }

  // Media3 + test dependencies into the app module.
  const gradleKey = 'app/build.gradle.kts';
  const anchor = '    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")';
  if (!files[gradleKey]?.includes(anchor)) {
    throw new Error('Phase 17 app/build.gradle.kts anchor not found; generator drift must be fixed before adding Media3');
  }
  files[gradleKey] = files[gradleKey].replace(
    anchor,
    `${anchor}\n    // Phase 34: AndroidX Media3 (Apache-2.0) — ExoPlayer preview + Transformer export\n    ${VIDEO_EDITOR_DEPENDENCIES.filter(d => d.startsWith('implementation')).join('\n    ')}\n    ${VIDEO_EDITOR_DEPENDENCIES.filter(d => d.startsWith('testImplementation')).join('\n    ')}\n    ${VIDEO_EDITOR_DEPENDENCIES.filter(d => d.startsWith('androidTestImplementation')).join('\n    ')}`
  );

  // Replace the starter activity with the editor's.
  const mainKey = Object.keys(files).find(k => k.endsWith('/MainActivity.kt'));
  if (!mainKey) throw new Error('Phase 17 base project has no MainActivity.kt to replace');
  files[mainKey] = mainActivityKt(pkg);

  files[`${root}/editor/EditorModels.kt`] = editorModelsKt(pkg);
  files[`${root}/editor/EditorOps.kt`] = editorOpsKt(pkg);
  files[`${root}/editor/ProjectStore.kt`] = projectStoreKt(pkg);
  files[`${root}/editor/SquadForgeApi.kt`] = squadForgeApiKt(pkg);
  files[`${root}/player/PreviewPlayer.kt`] = previewPlayerKt(pkg);
  files[`${root}/export/ExportPlan.kt`] = exportPlanKt(pkg);
  files[`${root}/export/VideoExporter.kt`] = videoExporterKt(pkg);
  files[`${root}/ui/EditorViewModel.kt`] = editorViewModelKt(pkg);
  files[`${root}/ui/EditorScreen.kt`] = editorScreenKt(pkg);

  const testRoot = `app/src/test/java/${packagePath(config)}`;
  files[`${testRoot}/EditorOpsTest.kt`] = editorOpsTestKt(pkg);
  files[`${testRoot}/ExportPlannerTest.kt`] = exportPlannerTestKt(pkg);

  const androidTestRoot = `app/src/androidTest/java/${packagePath(config)}`;
  files[`${androidTestRoot}/ExportParityTest.kt`] = exportParityTestKt(pkg);

  files['VIDEO_EDITOR_README.md'] = videoEditorReadme(config);
  return files;
}

function videoEditorReadme(config: AndroidProjectConfig): string {
  return `# ClipForge — Native Android Video Editor (Phase 34)

Generated by SquadForge's Phase 34 generator on top of the Phase 17
Android engine. Package: ${config.packageName}.

## What it is
A genuine native editor: Kotlin + Jetpack Compose UI, ExoPlayer
(Media3) preview, Media3 Transformer export. No WebView.

- Import: Android photo picker (video/image) and document picker
  (audio). No storage permission is requested; the pickers grant
  access to the picked items only, and grants are persisted.
- Editing: multitrack timeline (video + audio tracks) with the same
  project model and operations as the SquadForge server engine —
  add/trim/split/move/remove clips, volume, speed, text overlays,
  captions, track gain/mute.
- Preview: ExoPlayer plays the base track's clips with their trims;
  text overlays and the active caption render natively in Compose
  over the player; audio tracks play through a second player kept
  in sync by the play/pause/seek controls.
- Export: Media3 Transformer renders the full timeline to MP4 at
  Source/480p/720p/1080p, with real progress and cancellation: the
  base video track, overlay (picture-in-picture) video and image
  tracks composited with their transforms, crossfade transitions
  rendered as genuine dissolves, per-clip speed and audio fades
  baked in, text overlays burned in at their project position,
  size and colour, and all unmuted audio tracks mixed at their
  timeline positions. A sidecar .srt with the project's captions
  is written next to the MP4. Export notes in the app state what
  was not included.
- Projects: saved as JSON in the app's private storage after every
  edit and reopened on launch (recovery). Optionally load/save the
  server project through the SquadForge video-editor API
  (Phase 31 endpoints) using your own session cookie.

## Known export limitations (stated, not hidden)
- Transition types other than crossfade (fade-black, fade-white,
  wipes, slides, zoom-in) render as cuts in the app export; the
  server export renders all types with ffmpeg xfade.
- Gaps or overlaps on the base video track are closed up in the
  app export (the base track plays back-to-back); overlay, text
  and audio timing follows the project timeline.

## Libraries and licenses
AndroidX Media3 ${MEDIA3_VERSION} (Apache-2.0), Jetpack Compose /
Material 3 (Apache-2.0), Kotlin coroutines (Apache-2.0), JUnit 4
(EPL-1.0, tests only), org.json (BSD-style, tests only on JVM; the
Android runtime copy is part of the platform).
`;
}

// ---------------------------------------------------------------------------
// Kotlin sources
// ---------------------------------------------------------------------------

function mainActivityKt(pkg: string): string {
  return `package ${pkg}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import ${pkg}.ui.EditorScreen
import ${pkg}.ui.EditorViewModel

class MainActivity : ComponentActivity() {
    private val viewModel: EditorViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        viewModel.attachContext(applicationContext)
        setContent {
            MaterialTheme {
                Surface {
                    EditorScreen(viewModel)
                }
            }
        }
    }
}
`;
}

function editorModelsKt(pkg: string): string {
  return `package ${pkg}.editor

import org.json.JSONArray
import org.json.JSONObject

/**
 * The SquadForge video project model (Phases 20/26-31), mirrored in
 * Kotlin with the same field names so a project JSON moves between
 * the server engine and this app unchanged.
 */

data class MediaAsset(
    val id: String,
    /** Content URI string on device (the server uses file paths). */
    val path: String,
    val durationSec: Double,
    val hasVideo: Boolean,
    val hasAudio: Boolean,
    val width: Int? = null,
    val height: Int? = null,
    val kind: String? = null
) {
    fun mediaKind(): String = kind ?: if (!hasVideo) "audio" else "video"
}

data class ClipTransform(
    val x: Double = 0.0,
    val y: Double = 0.0,
    val scale: Double = 1.0,
    val rotationDeg: Double = 0.0,
    val opacity: Double = 1.0
)

data class TimelineClip(
    val id: String,
    val mediaId: String,
    val trackStart: Double,
    val sourceIn: Double,
    val sourceOut: Double,
    val volume: Double = 1.0,
    val title: String? = null,
    val speed: Double? = null,
    val transform: ClipTransform? = null,
    val fadeInSec: Double? = null,
    val fadeOutSec: Double? = null
) {
    fun speedOrDefault(): Double = speed ?: 1.0
    /** Timeline duration: source span divided by speed. */
    fun duration(): Double = (sourceOut - sourceIn) / speedOrDefault()
    fun trackEnd(): Double = trackStart + duration()
}

data class TimelineTrack(
    val id: String,
    val kind: String, // "video" | "audio"
    val name: String,
    val clips: List<TimelineClip> = emptyList(),
    val volume: Double? = null,
    val muted: Boolean? = null
)

data class Transition(
    val afterClipId: String,
    val type: String = "crossfade",
    val durationSec: Double = 0.5
)

data class TextElement(
    val id: String,
    val text: String,
    val trackStart: Double,
    val durationSec: Double,
    val x: Double = 40.0,
    val y: Double = 40.0,
    val fontSize: Double = 48.0,
    val color: String = "#FFFFFF",
    val opacity: Double? = null
) {
    fun trackEnd(): Double = trackStart + durationSec
}

data class CaptionCue(
    val id: String,
    val startSec: Double,
    val endSec: Double,
    val text: String
)

data class VideoProject(
    val id: String,
    val name: String,
    val width: Int = 1280,
    val height: Int = 720,
    val fps: Double = 30.0,
    val tracks: List<TimelineTrack> = emptyList(),
    val media: List<MediaAsset> = emptyList(),
    val transitions: List<Transition> = emptyList(),
    val texts: List<TextElement> = emptyList(),
    val captions: List<CaptionCue> = emptyList()
) {
    fun duration(): Double {
        var end = 0.0
        for (track in tracks) for (clip in track.clips) if (clip.trackEnd() > end) end = clip.trackEnd()
        for (text in texts) if (text.trackEnd() > end) end = text.trackEnd()
        return end
    }

    fun baseVideoTrack(): TimelineTrack? = tracks.firstOrNull { it.kind == "video" }

    fun toJson(): JSONObject {
        val json = JSONObject()
        json.put("id", id)
        json.put("name", name)
        json.put("width", width)
        json.put("height", height)
        json.put("fps", fps)
        json.put("media", JSONArray().apply {
            for (m in media) {
                put(JSONObject().apply {
                    put("id", m.id); put("path", m.path); put("durationSec", m.durationSec)
                    put("hasVideo", m.hasVideo); put("hasAudio", m.hasAudio)
                    m.width?.let { put("width", it) }; m.height?.let { put("height", it) }
                    m.kind?.let { put("kind", it) }
                })
            }
        })
        json.put("tracks", JSONArray().apply {
            for (t in tracks) {
                put(JSONObject().apply {
                    put("id", t.id); put("kind", t.kind); put("name", t.name)
                    t.volume?.let { put("volume", it) }; t.muted?.let { put("muted", it) }
                    put("clips", JSONArray().apply {
                        for (c in t.clips) {
                            put(JSONObject().apply {
                                put("id", c.id); put("mediaId", c.mediaId)
                                put("trackStart", c.trackStart); put("sourceIn", c.sourceIn)
                                put("sourceOut", c.sourceOut); put("volume", c.volume)
                                put("effect", JSONObject().put("type", "none"))
                                c.title?.let { put("title", it) }
                                c.speed?.let { put("speed", it) }
                                c.fadeInSec?.let { put("fadeInSec", it) }
                                c.fadeOutSec?.let { put("fadeOutSec", it) }
                                c.transform?.let { tr ->
                                    put("transform", JSONObject().apply {
                                        put("x", tr.x); put("y", tr.y); put("scale", tr.scale)
                                        put("rotationDeg", tr.rotationDeg); put("opacity", tr.opacity)
                                    })
                                }
                            })
                        }
                    })
                })
            }
        })
        json.put("transitions", JSONArray().apply {
            for (t in transitions) {
                put(JSONObject().apply {
                    put("afterClipId", t.afterClipId); put("type", t.type); put("durationSec", t.durationSec)
                })
            }
        })
        json.put("texts", JSONArray().apply {
            for (t in texts) {
                put(JSONObject().apply {
                    put("id", t.id); put("text", t.text); put("trackStart", t.trackStart)
                    put("durationSec", t.durationSec); put("x", t.x); put("y", t.y)
                    put("fontSize", t.fontSize); put("color", t.color)
                    t.opacity?.let { put("opacity", it) }
                })
            }
        })
        json.put("captions", JSONArray().apply {
            for (c in captions) {
                put(JSONObject().apply {
                    put("id", c.id); put("startSec", c.startSec); put("endSec", c.endSec); put("text", c.text)
                })
            }
        })
        return json
    }

    companion object {
        fun fromJson(json: JSONObject): VideoProject {
            val media = ArrayList<MediaAsset>()
            val mediaArr = json.optJSONArray("media") ?: JSONArray()
            for (i in 0 until mediaArr.length()) {
                val m = mediaArr.getJSONObject(i)
                media.add(
                    MediaAsset(
                        id = m.getString("id"),
                        path = m.getString("path"),
                        durationSec = m.optDouble("durationSec", 0.0),
                        hasVideo = m.optBoolean("hasVideo", true),
                        hasAudio = m.optBoolean("hasAudio", true),
                        width = if (m.has("width")) m.getInt("width") else null,
                        height = if (m.has("height")) m.getInt("height") else null,
                        kind = if (m.has("kind")) m.getString("kind") else null
                    )
                )
            }
            val tracks = ArrayList<TimelineTrack>()
            val tracksArr = json.optJSONArray("tracks") ?: JSONArray()
            for (i in 0 until tracksArr.length()) {
                val t = tracksArr.getJSONObject(i)
                val clips = ArrayList<TimelineClip>()
                val clipsArr = t.optJSONArray("clips") ?: JSONArray()
                for (j in 0 until clipsArr.length()) {
                    val c = clipsArr.getJSONObject(j)
                    val tr = c.optJSONObject("transform")
                    clips.add(
                        TimelineClip(
                            id = c.getString("id"),
                            mediaId = c.getString("mediaId"),
                            trackStart = c.getDouble("trackStart"),
                            sourceIn = c.getDouble("sourceIn"),
                            sourceOut = c.getDouble("sourceOut"),
                            volume = c.optDouble("volume", 1.0),
                            title = if (c.has("title")) c.getString("title") else null,
                            speed = if (c.has("speed")) c.getDouble("speed") else null,
                            transform = tr?.let {
                                ClipTransform(
                                    x = it.optDouble("x", 0.0), y = it.optDouble("y", 0.0),
                                    scale = it.optDouble("scale", 1.0),
                                    rotationDeg = it.optDouble("rotationDeg", 0.0),
                                    opacity = it.optDouble("opacity", 1.0)
                                )
                            },
                            fadeInSec = if (c.has("fadeInSec")) c.getDouble("fadeInSec") else null,
                            fadeOutSec = if (c.has("fadeOutSec")) c.getDouble("fadeOutSec") else null
                        )
                    )
                }
                tracks.add(
                    TimelineTrack(
                        id = t.getString("id"),
                        kind = t.getString("kind"),
                        name = t.optString("name", t.getString("kind")),
                        clips = clips,
                        volume = if (t.has("volume")) t.getDouble("volume") else null,
                        muted = if (t.has("muted")) t.getBoolean("muted") else null
                    )
                )
            }
            val transitions = ArrayList<Transition>()
            val trArr = json.optJSONArray("transitions") ?: JSONArray()
            for (i in 0 until trArr.length()) {
                val t = trArr.getJSONObject(i)
                transitions.add(
                    Transition(
                        afterClipId = t.getString("afterClipId"),
                        type = t.optString("type", "crossfade"),
                        durationSec = t.optDouble("durationSec", 0.5)
                    )
                )
            }
            val texts = ArrayList<TextElement>()
            val textsArr = json.optJSONArray("texts") ?: JSONArray()
            for (i in 0 until textsArr.length()) {
                val t = textsArr.getJSONObject(i)
                texts.add(
                    TextElement(
                        id = t.getString("id"),
                        text = t.getString("text"),
                        trackStart = t.getDouble("trackStart"),
                        durationSec = t.getDouble("durationSec"),
                        x = t.optDouble("x", 40.0), y = t.optDouble("y", 40.0),
                        fontSize = t.optDouble("fontSize", 48.0),
                        color = t.optString("color", "#FFFFFF"),
                        opacity = if (t.has("opacity")) t.getDouble("opacity") else null
                    )
                )
            }
            val captions = ArrayList<CaptionCue>()
            val capArr = json.optJSONArray("captions") ?: JSONArray()
            for (i in 0 until capArr.length()) {
                val c = capArr.getJSONObject(i)
                captions.add(
                    CaptionCue(
                        id = c.getString("id"),
                        startSec = c.getDouble("startSec"),
                        endSec = c.getDouble("endSec"),
                        text = c.getString("text")
                    )
                )
            }
            return VideoProject(
                id = json.getString("id"),
                name = json.optString("name", "Untitled"),
                width = json.optInt("width", 1280),
                height = json.optInt("height", 720),
                fps = json.optDouble("fps", 30.0),
                tracks = tracks,
                media = media,
                transitions = transitions,
                texts = texts,
                captions = captions
            )
        }
    }
}
`;
}

function editorOpsKt(pkg: string): string {
  return `package ${pkg}.editor

import java.util.UUID

/**
 * Non-destructive editing operations on the project model — the same
 * operation names and validation rules as the SquadForge server
 * engine's editingOps dispatcher (Phases 26-29). Every operation
 * returns a NEW project; the input is never mutated. Invalid
 * operations throw IllegalArgumentException with a plain message,
 * which the UI surfaces instead of silently corrupting the timeline.
 */
object EditorOps {

    private fun newId(prefix: String): String = prefix + "_" + UUID.randomUUID().toString().substring(0, 8)

    fun createProject(name: String, width: Int = 1280, height: Int = 720, fps: Double = 30.0): VideoProject {
        return VideoProject(
            id = newId("project"),
            name = name,
            width = width,
            height = height,
            fps = fps,
            tracks = listOf(
                TimelineTrack(id = newId("track"), kind = "video", name = "Video 1"),
                TimelineTrack(id = newId("track"), kind = "audio", name = "Audio 1")
            )
        )
    }

    fun addTrack(project: VideoProject, kind: String): VideoProject {
        require(kind == "video" || kind == "audio") { "Track kind must be video or audio" }
        val count = project.tracks.count { it.kind == kind }
        val track = TimelineTrack(
            id = newId("track"), kind = kind,
            name = (if (kind == "video") "Video " else "Audio ") + (count + 1)
        )
        return project.copy(tracks = project.tracks + track)
    }

    fun addMedia(project: VideoProject, asset: MediaAsset): VideoProject {
        if (project.media.any { it.id == asset.id }) return project
        return project.copy(media = project.media + asset)
    }

    private fun overlaps(track: TimelineTrack, start: Double, end: Double, ignoreClipId: String?): Boolean {
        return track.clips.any { it.id != ignoreClipId && start < it.trackEnd() - 1e-6 && end > it.trackStart + 1e-6 }
    }

    fun addClip(project: VideoProject, trackId: String, mediaId: String, trackStart: Double): VideoProject {
        val track = project.tracks.firstOrNull { it.id == trackId }
            ?: throw IllegalArgumentException("Track not found")
        val asset = project.media.firstOrNull { it.id == mediaId }
            ?: throw IllegalArgumentException("Media not found")
        val isImage = asset.mediaKind() == "image"
        val sourceOut = if (isImage) 3.0 else asset.durationSec
        require(sourceOut > 0.0) { "Media has no usable duration" }
        val clip = TimelineClip(
            id = newId("clip"), mediaId = mediaId,
            trackStart = trackStart, sourceIn = 0.0, sourceOut = sourceOut
        )
        require(!overlaps(track, clip.trackStart, clip.trackEnd(), null)) { "Clip would overlap an existing clip on this track" }
        val updated = track.copy(clips = (track.clips + clip).sortedBy { it.trackStart })
        return project.copy(tracks = project.tracks.map { if (it.id == trackId) updated else it })
    }

    private fun mapClip(project: VideoProject, clipId: String, change: (TimelineClip, TimelineTrack) -> TimelineClip): VideoProject {
        var found = false
        val tracks = project.tracks.map { track ->
            val idx = track.clips.indexOfFirst { it.id == clipId }
            if (idx < 0) {
                track
            } else {
                found = true
                val changed = change(track.clips[idx], track)
                val clips = track.clips.toMutableList()
                clips[idx] = changed
                track.copy(clips = clips.sortedBy { it.trackStart })
            }
        }
        if (!found) throw IllegalArgumentException("Clip not found")
        return project.copy(tracks = tracks)
    }

    fun trimClip(project: VideoProject, clipId: String, sourceIn: Double, sourceOut: Double): VideoProject {
        return mapClip(project, clipId) { clip, track ->
            val asset = project.media.firstOrNull { it.id == clip.mediaId }
            val maxOut = asset?.durationSec ?: clip.sourceOut
            val newIn = sourceIn.coerceIn(0.0, maxOut)
            val newOut = sourceOut.coerceIn(newIn + 0.1, maxOut)
            val changed = clip.copy(sourceIn = newIn, sourceOut = newOut)
            require(!overlaps(track, changed.trackStart, changed.trackEnd(), clip.id)) { "Trim would overlap the next clip" }
            changed
        }
    }

    fun splitClip(project: VideoProject, clipId: String, atTimelineSec: Double): VideoProject {
        val track = project.tracks.firstOrNull { t -> t.clips.any { it.id == clipId } }
            ?: throw IllegalArgumentException("Clip not found")
        val clip = track.clips.first { it.id == clipId }
        val offset = atTimelineSec - clip.trackStart
        require(offset > 0.05 && offset < clip.duration() - 0.05) { "Split point must be inside the clip" }
        val sourceSplit = clip.sourceIn + offset * clip.speedOrDefault()
        val first = clip.copy(sourceOut = sourceSplit)
        val second = clip.copy(
            id = newId("clip"),
            trackStart = atTimelineSec,
            sourceIn = sourceSplit
        )
        val clips = (track.clips.filter { it.id != clipId } + first + second).sortedBy { it.trackStart }
        return project.copy(tracks = project.tracks.map { if (it.id == track.id) track.copy(clips = clips) else it })
    }

    fun moveClip(project: VideoProject, clipId: String, newTrackStart: Double): VideoProject {
        return mapClip(project, clipId) { clip, track ->
            val start = newTrackStart.coerceAtLeast(0.0)
            val changed = clip.copy(trackStart = start)
            require(!overlaps(track, changed.trackStart, changed.trackEnd(), clip.id)) { "Move would overlap another clip" }
            changed
        }
    }

    fun removeClip(project: VideoProject, clipId: String): VideoProject {
        return project.copy(tracks = project.tracks.map { track ->
            track.copy(clips = track.clips.filter { it.id != clipId })
        })
    }

    fun setClipVolume(project: VideoProject, clipId: String, volume: Double): VideoProject {
        return mapClip(project, clipId) { clip, _ -> clip.copy(volume = volume.coerceIn(0.0, 1.0)) }
    }

    fun setClipSpeed(project: VideoProject, clipId: String, speed: Double): VideoProject {
        return mapClip(project, clipId) { clip, track ->
            val changed = clip.copy(speed = speed.coerceIn(0.25, 4.0))
            require(!overlaps(track, changed.trackStart, changed.trackEnd(), clip.id)) { "Speed change would overlap the next clip" }
            changed
        }
    }

    fun setTrackVolume(project: VideoProject, trackId: String, volume: Double): VideoProject {
        return project.copy(tracks = project.tracks.map {
            if (it.id == trackId) it.copy(volume = volume.coerceIn(0.0, 2.0)) else it
        })
    }

    fun setTrackMuted(project: VideoProject, trackId: String, muted: Boolean): VideoProject {
        return project.copy(tracks = project.tracks.map {
            if (it.id == trackId) it.copy(muted = muted) else it
        })
    }

    fun addText(project: VideoProject, text: String, trackStart: Double, durationSec: Double = 3.0): VideoProject {
        val element = TextElement(
            id = newId("text"), text = text,
            trackStart = trackStart.coerceAtLeast(0.0), durationSec = durationSec.coerceAtLeast(0.5)
        )
        return project.copy(texts = project.texts + element)
    }

    fun updateText(project: VideoProject, textId: String, newText: String): VideoProject {
        return project.copy(texts = project.texts.map { if (it.id == textId) it.copy(text = newText) else it })
    }

    fun removeText(project: VideoProject, textId: String): VideoProject {
        return project.copy(texts = project.texts.filter { it.id != textId })
    }

    fun addCaption(project: VideoProject, startSec: Double, endSec: Double, text: String): VideoProject {
        require(endSec > startSec) { "Caption end must be after its start" }
        val cue = CaptionCue(id = newId("caption"), startSec = startSec, endSec = endSec, text = text)
        return project.copy(captions = (project.captions + cue).sortedBy { it.startSec })
    }

    fun removeCaption(project: VideoProject, captionId: String): VideoProject {
        return project.copy(captions = project.captions.filter { it.id != captionId })
    }

    fun addTransition(project: VideoProject, afterClipId: String, type: String, durationSec: Double = 0.5): VideoProject {
        val known = setOf("crossfade", "fade-black", "fade-white", "wipe-left", "wipe-right", "slide-left", "slide-right", "zoom-in")
        require(type in known) { "Unknown transition type: " + type }
        val transition = Transition(afterClipId = afterClipId, type = type, durationSec = durationSec.coerceIn(0.1, 2.0))
        return project.copy(transitions = project.transitions.filter { it.afterClipId != afterClipId } + transition)
    }

    /** SRT export of the caption track (same format as the server engine). */
    fun captionsToSrt(project: VideoProject): String {
        fun stamp(sec: Double): String {
            val totalMs = (sec * 1000).toLong()
            val h = totalMs / 3_600_000
            val m = (totalMs % 3_600_000) / 60_000
            val s = (totalMs % 60_000) / 1000
            val ms = totalMs % 1000
            return String.format("%02d:%02d:%02d,%03d", h, m, s, ms)
        }
        val out = StringBuilder()
        project.captions.sortedBy { it.startSec }.forEachIndexed { index, cue ->
            out.append(index + 1).append('\\n')
            out.append(stamp(cue.startSec)).append(" --> ").append(stamp(cue.endSec)).append('\\n')
            out.append(cue.text).append("\\n\\n")
        }
        return out.toString()
    }
}
`;
}

function projectStoreKt(pkg: string): string {
  return `package ${pkg}.editor

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * On-device project persistence: the project JSON lives in the app's
 * private storage, is rewritten after every edit, and the most
 * recent project is reopened on launch — save, reopen and crash
 * recovery with no server involved.
 */
class ProjectStore(context: Context) {
    private val dir = File(context.filesDir, "projects").apply { mkdirs() }
    private val pointerFile = File(context.filesDir, "last_project.txt")

    fun save(project: VideoProject) {
        val file = File(dir, project.id + ".json")
        val tmp = File(dir, project.id + ".json.tmp")
        tmp.writeText(project.toJson().toString())
        tmp.renameTo(file)
        pointerFile.writeText(project.id)
    }

    fun load(projectId: String): VideoProject? {
        val file = File(dir, projectId + ".json")
        if (!file.exists()) return null
        return try {
            VideoProject.fromJson(JSONObject(file.readText()))
        } catch (e: Exception) {
            null
        }
    }

    fun loadLast(): VideoProject? {
        if (!pointerFile.exists()) return null
        val id = pointerFile.readText().trim()
        if (id.isEmpty()) return null
        return load(id)
    }

    fun delete(projectId: String) {
        File(dir, projectId + ".json").delete()
        if (pointerFile.exists() && pointerFile.readText().trim() == projectId) pointerFile.delete()
    }
}
`;
}

function squadForgeApiKt(pkg: string): string {
  return `package ${pkg}.editor

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Optional connection to the SquadForge server's video-editor API
 * (Phase 31): load the server-side project for a build and save it
 * back. The user supplies the server base URL, the build id and
 * their own session cookie in the app's settings; the cookie is
 * stored only in the app's private preferences and sent only to
 * that server. All calls are plain HTTPS/HTTP via HttpURLConnection
 * on a background thread (callers use coroutines).
 *
 * Wire format: the server speaks the SerializedVideoProject
 * envelope — { format: "squadforge-video-project", version: 1,
 * project: {...}, media: [...] } — with media OUTSIDE the project
 * object, while this app's model (and its on-device files) keep
 * media inside VideoProject.toJson(). load/save translate between
 * the two shapes; feeding the envelope straight to
 * VideoProject.fromJson would silently yield an empty project.
 */
class SquadForgeApi(
    private val baseUrl: String,
    private val buildId: String,
    private val sessionCookie: String
) {
    private fun connect(path: String, method: String): HttpURLConnection {
        val url = URL(baseUrl.trimEnd('/') + "/api/builds/" + buildId + "/video-editor" + path)
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 15_000
        conn.readTimeout = 30_000
        if (sessionCookie.isNotBlank()) {
            conn.setRequestProperty("Cookie", sessionCookie)
        }
        conn.setRequestProperty("Accept", "application/json")
        return conn
    }

    fun loadProject(): VideoProject {
        val conn = connect("/project/load", "GET")
        val code = conn.responseCode
        val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
            ?.bufferedReader()?.readText() ?: ""
        if (code !in 200..299) {
            throw IllegalStateException("Server load failed (HTTP " + code + "): " + body.take(200))
        }
        val json = JSONObject(body)
        val envelope = json.optJSONObject("project")
            ?: throw IllegalStateException("Server response did not contain a project")
        val inner = envelope.optJSONObject("project")
            ?: throw IllegalStateException("Server project envelope did not contain a project")
        // Translate the envelope into the model's shape: media lives
        // outside the project object on the wire, inside it on device.
        val merged = JSONObject(inner.toString())
        merged.put("media", envelope.optJSONArray("media") ?: JSONArray())
        return VideoProject.fromJson(merged)
    }

    fun saveProject(project: VideoProject) {
        val conn = connect("/project/save", "POST")
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        // Translate the model into the server's envelope: media moves
        // out of the project object into the envelope's media array,
        // which is what deserializeVideoProject on the server expects.
        val projectJson = project.toJson()
        val media = projectJson.optJSONArray("media") ?: JSONArray()
        projectJson.remove("media")
        val payload = JSONObject()
        payload.put("format", "squadforge-video-project")
        payload.put("version", 1)
        payload.put("project", projectJson)
        payload.put("media", media)
        conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
        val code = conn.responseCode
        if (code !in 200..299) {
            val body = conn.errorStream?.bufferedReader()?.readText() ?: ""
            throw IllegalStateException("Server save failed (HTTP " + code + "): " + body.take(200))
        }
    }
}
`;
}

function previewPlayerKt(pkg: string): string {
  return `package ${pkg}.player

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import ${pkg}.editor.VideoProject

/**
 * Genuine playback of the edited timeline with ExoPlayer (Media3).
 * The base video track's clips become one concatenated playlist with
 * per-clip clipping, so play/pause/seek operate on the edited
 * timeline, not on a raw file. The first audio track plays through a
 * second player started and paused together with the video player.
 * Nothing is decoded into memory by the app itself; ExoPlayer
 * streams from the content URIs.
 */
class PreviewPlayer(context: Context) {
    val videoPlayer: ExoPlayer = ExoPlayer.Builder(context).build()
    val audioPlayer: ExoPlayer = ExoPlayer.Builder(context).build()

    fun loadProject(project: VideoProject) {
        val mediaById = project.media.associateBy { it.id }
        val base = project.baseVideoTrack()
        val videoItems = ArrayList<MediaItem>()
        if (base != null) {
            for (clip in base.clips.sortedBy { it.trackStart }) {
                val asset = mediaById[clip.mediaId] ?: continue
                if (!asset.hasVideo) continue
                val item = MediaItem.Builder()
                    .setUri(Uri.parse(asset.path))
                    .setClippingConfiguration(
                        MediaItem.ClippingConfiguration.Builder()
                            .setStartPositionMs((clip.sourceIn * 1000).toLong())
                            .setEndPositionMs((clip.sourceOut * 1000).toLong())
                            .build()
                    )
                    .build()
                videoItems.add(item)
            }
        }
        videoPlayer.setMediaItems(videoItems)
        videoPlayer.prepare()

        val audioTrack = project.tracks.firstOrNull { it.kind == "audio" }
        val audioItems = ArrayList<MediaItem>()
        if (audioTrack != null) {
            for (clip in audioTrack.clips.sortedBy { it.trackStart }) {
                val asset = mediaById[clip.mediaId] ?: continue
                val item = MediaItem.Builder()
                    .setUri(Uri.parse(asset.path))
                    .setClippingConfiguration(
                        MediaItem.ClippingConfiguration.Builder()
                            .setStartPositionMs((clip.sourceIn * 1000).toLong())
                            .setEndPositionMs((clip.sourceOut * 1000).toLong())
                            .build()
                    )
                    .build()
                audioItems.add(item)
            }
        }
        audioPlayer.setMediaItems(audioItems)
        audioPlayer.prepare()
        val trackVolume = audioTrack?.volume ?: 1.0
        audioPlayer.volume = if (audioTrack?.muted == true) 0f else trackVolume.toFloat().coerceIn(0f, 1f)
    }

    fun play() {
        videoPlayer.play()
        audioPlayer.play()
    }

    fun pause() {
        videoPlayer.pause()
        audioPlayer.pause()
    }

    fun seekTo(positionMs: Long) {
        videoPlayer.seekTo(positionMs)
        audioPlayer.seekTo(positionMs)
    }

    fun release() {
        videoPlayer.release()
        audioPlayer.release()
    }
}
`;
}

function exportPlanKt(pkg: string): string {
  return `package ${pkg}.export

import ${pkg}.editor.ClipTransform
import ${pkg}.editor.TimelineClip
import ${pkg}.editor.VideoProject
import kotlin.math.abs
import kotlin.math.max

/**
 * Phase 37: the export plan — a pure, JVM-testable description of
 * exactly what the Media3 export will render, computed from the
 * project model with the same timeline maths as the server engine
 * (clip duration = source span / speed; a crossfade overlaps the
 * last d seconds of a junction, so the export is d shorter per
 * rendered junction; clip fades are audio fades measured from the
 * clip's timeline start/end).
 *
 * The plan is a list of parallel Media3 sequences. Sequence 0 is
 * the base video track, cut into segments at text boundaries and
 * transition junctions. Crossfade heads (the first d seconds of
 * the incoming clip) live in their own sequence, gap-positioned
 * over the outgoing clip's tail, with a compositor window that
 * ramps their alpha 0 to 1 — a genuine dissolve rendered by
 * Media3's DefaultVideoCompositor. Each overlay video track gets
 * a gap-positioned sequence plus one compositor window per clip
 * carrying its Phase 26 transform (position, scale, rotation,
 * opacity). Audio tracks are gap-positioned sequences with
 * per-clip gain, fades and speed. What the plan cannot express is
 * reported in the notes, never silently dropped.
 */

data class PlanText(
    val text: String,
    val xFrac: Double,
    val yFrac: Double,
    val fontSize: Double,
    val colorHex: String,
    val opacity: Double
)

data class PlanItem(
    val path: String,
    val isImage: Boolean,
    val hasAudio: Boolean,
    val sourceIn: Double,
    val sourceOut: Double,
    val speed: Double,
    val gain: Double,
    val fadeInSec: Double,
    val fadeOutSec: Double,
    val extraFadeInSec: Double,
    val extraFadeOutSec: Double,
    val clipDurationSec: Double,
    val segmentOffsetSec: Double,
    val segmentDurationSec: Double,
    val removeAudio: Boolean,
    val applyPresentation: Boolean,
    val texts: List<PlanText>
)

sealed class PlanElement {
    data class Gap(val durationSec: Double) : PlanElement()
    data class Item(val item: PlanItem) : PlanElement()
}

/** Placement for one overlay sequence over a time window (export seconds). */
data class PlanWindow(
    val sequenceIndex: Int,
    val startSec: Double,
    val endSec: Double,
    val scaleX: Double,
    val scaleY: Double,
    val anchorX: Double,
    val anchorY: Double,
    val alpha: Double,
    val fadeInSec: Double,
    val rotationDeg: Double
)

data class ExportPlan(
    val sequences: List<List<PlanElement>>,
    val windows: List<PlanWindow>,
    val outputWidth: Int,
    val outputHeight: Int,
    val totalDurationSec: Double,
    val notes: List<String>
)

object ExportPlanner {

    /** Transition types Media3 renders for real in the app export. */
    val REAL_TRANSITIONS = setOf("crossfade")

    private data class HeadEntry(val windowStartSec: Double, val item: PlanItem, val durationSec: Double, val mediaWidth: Int)

    fun plan(project: VideoProject, targetWidth: Int?, targetHeight: Int?): ExportPlan {
        val outW = targetWidth ?: project.width
        val outH = targetHeight ?: project.height
        val projW = project.width.toDouble()
        val projH = project.height.toDouble()
        val notes = ArrayList<String>()
        val mediaById = project.media.associateBy { it.id }
        val sequences = ArrayList<List<PlanElement>>()
        val windows = ArrayList<PlanWindow>()

        val base = project.baseVideoTrack()
        val baseClips = base?.clips?.sortedBy { it.trackStart } ?: emptyList()

        // Export start of each base clip: project time minus the
        // crossfade shrinkage accumulated before it.
        val junction = HashMap<String, Double>()
        val unsupportedTypes = sortedSetOf<String>()
        var foreignTransitions = 0
        for (t in project.transitions) {
            val idx = baseClips.indexOfFirst { it.id == t.afterClipId }
            if (idx < 0 || idx >= baseClips.size - 1) {
                foreignTransitions++
                continue
            }
            if (t.type !in REAL_TRANSITIONS) {
                unsupportedTypes.add(t.type)
                continue
            }
            val a = baseClips[idx]
            val b = baseClips[idx + 1]
            val d = minOf(t.durationSec, 0.5 * a.duration(), 0.5 * b.duration())
            if (d >= 0.05) junction[a.id] = d else unsupportedTypes.add(t.type)
        }
        if (unsupportedTypes.isNotEmpty()) {
            notes.add("Transition type(s) " + unsupportedTypes.joinToString(", ") + " render as cuts in the app export; crossfade is rendered for real and the server export renders all types")
        }
        if (foreignTransitions > 0) {
            notes.add("Transitions after the last base-track clip or on other tracks render as cuts in the app export")
        }

        val exportStart = HashMap<String, Double>()
        var expCursor = 0.0
        var projCursor = 0.0
        var contiguous = true
        for (clip in baseClips) {
            if (abs(clip.trackStart - projCursor) > 0.002) contiguous = false
            exportStart[clip.id] = expCursor
            expCursor += clip.duration() - (junction[clip.id] ?: 0.0)
            projCursor = clip.trackEnd()
        }
        if (!contiguous && baseClips.isNotEmpty()) {
            notes.add("Gaps or overlaps on the base video track are closed up in the app export; overlay, text and audio timing follows the project timeline")
        }

        fun exportTime(projectT: Double): Double {
            if (baseClips.isEmpty()) return projectT
            var chosen = baseClips[0]
            for (clip in baseClips) {
                if (clip.trackStart <= projectT + 0.002) chosen = clip
            }
            return projectT - (chosen.trackStart - (exportStart[chosen.id] ?: 0.0))
        }

        // ---- base track, segmented at text and junction boundaries ----
        val baseElements = ArrayList<PlanElement>()
        val heads = ArrayList<HeadEntry>()
        if (base != null) {
            val trackGain = base.volume ?: 1.0
            for ((ci, clip) in baseClips.withIndex()) {
                val asset = mediaById[clip.mediaId] ?: continue
                val isImage = asset.mediaKind() == "image"
                if (!isImage && !asset.hasVideo) continue
                val dur = clip.duration()
                val headD = if (ci > 0) (junction[baseClips[ci - 1].id] ?: 0.0) else 0.0
                val tailD = junction[clip.id] ?: 0.0
                val cuts = sortedSetOf(0.0, dur)
                if (headD > 0) cuts.add(headD)
                if (tailD > 0) cuts.add(dur - tailD)
                for (text in project.texts) {
                    val s = text.trackStart - clip.trackStart
                    val e = text.trackEnd() - clip.trackStart
                    if (s > 0.0 && s < dur) cuts.add(s)
                    if (e > 0.0 && e < dur) cuts.add(e)
                }
                val pts = cuts.toList()
                for (si in 0 until pts.size - 1) {
                    val s0 = pts[si]
                    val s1 = pts[si + 1]
                    val segDur = s1 - s0
                    if (segDur <= 0.001) continue
                    val isHead = headD > 0 && s0 < 0.001
                    val isTail = tailD > 0 && s1 > dur - 0.001
                    val segTexts = project.texts
                        .filter { it.trackStart < clip.trackStart + s1 && it.trackEnd() > clip.trackStart + s0 }
                        .map {
                            PlanText(
                                it.text, it.x / projW, it.y / projH,
                                it.fontSize, it.color, it.opacity ?: 1.0
                            )
                        }
                    val item = PlanItem(
                        path = asset.path,
                        isImage = isImage,
                        hasAudio = asset.hasAudio && !isImage,
                        sourceIn = clip.sourceIn + s0 * clip.speedOrDefault(),
                        sourceOut = clip.sourceIn + s1 * clip.speedOrDefault(),
                        speed = clip.speedOrDefault(),
                        gain = clip.volume * trackGain,
                        fadeInSec = clip.fadeInSec ?: 0.0,
                        fadeOutSec = clip.fadeOutSec ?: 0.0,
                        extraFadeInSec = if (isHead) headD else 0.0,
                        extraFadeOutSec = if (isTail) tailD else 0.0,
                        clipDurationSec = dur,
                        segmentOffsetSec = s0,
                        segmentDurationSec = segDur,
                        removeAudio = false,
                        applyPresentation = targetWidth != null && targetHeight != null,
                        texts = segTexts
                    )
                    if (isHead) {
                        heads.add(HeadEntry(exportStart[clip.id] ?: 0.0, item, headD, asset.width ?: project.width))
                    } else {
                        baseElements.add(PlanElement.Item(item))
                    }
                }
            }
        }
        if (baseElements.isNotEmpty()) {
            sequences.add(baseElements)
        }

        // ---- crossfade heads sequence ----
        if (heads.isNotEmpty() && baseElements.isNotEmpty()) {
            val seqIndex = sequences.size
            val elements = ArrayList<PlanElement>()
            var cursor = 0.0
            for (head in heads.sortedBy { it.windowStartSec }) {
                val gap = head.windowStartSec - cursor
                if (gap > 0.001) elements.add(PlanElement.Gap(gap))
                elements.add(PlanElement.Item(head.item))
                cursor = max(cursor, head.windowStartSec) + head.durationSec
                windows.add(
                    PlanWindow(
                        sequenceIndex = seqIndex,
                        startSec = head.windowStartSec,
                        endSec = head.windowStartSec + head.durationSec,
                        scaleX = 1.0,
                        scaleY = 1.0,
                        anchorX = 0.0,
                        anchorY = 0.0,
                        alpha = 1.0,
                        fadeInSec = head.durationSec,
                        rotationDeg = 0.0
                    )
                )
            }
            sequences.add(elements)
        }

        // ---- overlay video tracks (PiP + image compositing) ----
        for (track in project.tracks.filter { it.kind == "video" && it.id != base?.id }) {
            val seqIndex = sequences.size
            val elements = ArrayList<PlanElement>()
            var cursor = 0.0
            var placed = 0
            for (clip in track.clips.sortedBy { it.trackStart }) {
                val asset = mediaById[clip.mediaId] ?: continue
                val kind = asset.mediaKind()
                if (kind != "video" && kind != "image") continue
                val startExp = exportTime(clip.trackStart)
                val actualStart = max(cursor, startExp)
                val gap = actualStart - cursor
                if (gap > 0.001) elements.add(PlanElement.Gap(gap))
                val dur = clip.duration()
                val tr = clip.transform ?: ClipTransform()
                val mw = (asset.width ?: project.width).toDouble()
                val mh = (asset.height ?: project.height).toDouble()
                val scaledW = mw * tr.scale
                val scaledH = mh * tr.scale
                val item = PlanItem(
                    path = asset.path,
                    isImage = kind == "image",
                    hasAudio = asset.hasAudio && kind != "image",
                    sourceIn = clip.sourceIn,
                    sourceOut = clip.sourceOut,
                    speed = clip.speedOrDefault(),
                    gain = clip.volume * (track.volume ?: 1.0),
                    fadeInSec = clip.fadeInSec ?: 0.0,
                    fadeOutSec = clip.fadeOutSec ?: 0.0,
                    extraFadeInSec = 0.0,
                    extraFadeOutSec = 0.0,
                    clipDurationSec = dur,
                    segmentOffsetSec = 0.0,
                    segmentDurationSec = dur,
                    removeAudio = false,
                    applyPresentation = false,
                    texts = emptyList()
                )
                elements.add(PlanElement.Item(item))
                windows.add(
                    PlanWindow(
                        sequenceIndex = seqIndex,
                        startSec = actualStart,
                        endSec = actualStart + dur,
                        scaleX = scaledW / projW,
                        scaleY = scaledH / projH,
                        anchorX = (tr.x + scaledW / 2.0) / projW * 2.0 - 1.0,
                        anchorY = 1.0 - (tr.y + scaledH / 2.0) / projH * 2.0,
                        alpha = tr.opacity,
                        fadeInSec = 0.0,
                        rotationDeg = tr.rotationDeg
                    )
                )
                cursor = actualStart + dur
                placed++
            }
            if (placed > 0) {
                sequences.add(elements)
            }
        }

        // ---- audio tracks ----
        for (track in project.tracks.filter { it.kind == "audio" && it.muted != true }) {
            val elements = ArrayList<PlanElement>()
            var cursor = 0.0
            var placed = 0
            for (clip in track.clips.sortedBy { it.trackStart }) {
                val asset = mediaById[clip.mediaId] ?: continue
                if (!asset.hasAudio) continue
                val startExp = exportTime(clip.trackStart)
                val actualStart = max(cursor, startExp)
                val gap = actualStart - cursor
                if (gap > 0.001) elements.add(PlanElement.Gap(gap))
                val dur = clip.duration()
                elements.add(
                    PlanElement.Item(
                        PlanItem(
                            path = asset.path,
                            isImage = false,
                            hasAudio = true,
                            sourceIn = clip.sourceIn,
                            sourceOut = clip.sourceOut,
                            speed = clip.speedOrDefault(),
                            gain = clip.volume * (track.volume ?: 1.0),
                            fadeInSec = clip.fadeInSec ?: 0.0,
                            fadeOutSec = clip.fadeOutSec ?: 0.0,
                            extraFadeInSec = 0.0,
                            extraFadeOutSec = 0.0,
                            clipDurationSec = dur,
                            segmentOffsetSec = 0.0,
                            segmentDurationSec = dur,
                            removeAudio = false,
                            applyPresentation = false,
                            texts = emptyList()
                        )
                    )
                )
                cursor = actualStart + dur
                placed++
            }
            if (placed > 0) {
                sequences.add(elements)
            }
        }

        var total = 0.0
        for (seq in sequences) {
            var sum = 0.0
            for (el in seq) {
                sum += when (el) {
                    is PlanElement.Gap -> el.durationSec
                    is PlanElement.Item -> el.item.segmentDurationSec
                }
            }
            if (sum > total) total = sum
        }

        return ExportPlan(sequences, windows, outW, outH, total, notes)
    }
}
`;
}


function videoExporterKt(pkg: string): string {
  return `package ${pkg}.export

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.text.SpannableString
import android.text.style.ForegroundColorSpan
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.OverlaySettings
import androidx.media3.common.VideoCompositorSettings
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.SpeedChangeEffect
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.effect.TextOverlay
import androidx.media3.effect.TextureOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import ${pkg}.editor.VideoProject
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Per-clip audio chain for export: constant gain plus the clip's
 * audio fades (fadeInSec / fadeOutSec, measured in clip-timeline
 * seconds exactly like the server engine's afade filters) plus an
 * optional extra ramp at this segment's edges, which is how a
 * crossfade's audio blend is rendered (outgoing tail ramps down,
 * incoming head ramps up). Applied to PCM samples; the segment's
 * offset inside its clip keeps fades aligned when a clip was cut
 * into segments at text or junction boundaries.
 */
@OptIn(UnstableApi::class)
class ClipAudioProcessor(
    private val gain: Float,
    private val fadeInSec: Double,
    private val fadeOutSec: Double,
    private val extraFadeInSec: Double,
    private val extraFadeOutSec: Double,
    private val clipDurationSec: Double,
    private val segmentOffsetSec: Double,
    private val segmentDurationSec: Double
) : BaseAudioProcessor() {

    private var sampleRate = 1
    private var channelCount = 1
    private var framesSeen = 0L

    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        if (inputAudioFormat.encoding != androidx.media3.common.C.ENCODING_PCM_16BIT) {
            throw AudioProcessor.UnhandledAudioFormatException(inputAudioFormat)
        }
        sampleRate = inputAudioFormat.sampleRate
        channelCount = inputAudioFormat.channelCount
        framesSeen = 0
        return inputAudioFormat
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val size = inputBuffer.remaining()
        if (size == 0) return
        val output = replaceOutputBuffer(size)
        val bytesPerFrame = 2 * channelCount
        val frames = size / bytesPerFrame
        var frame = 0
        while (frame < frames) {
            val localT = (framesSeen + frame).toDouble() / sampleRate
            val clipT = segmentOffsetSec + localT
            var env = 1.0
            if (fadeInSec > 0 && clipT < fadeInSec) {
                env *= clipT / fadeInSec
            }
            if (fadeOutSec > 0 && clipT > clipDurationSec - fadeOutSec) {
                env *= max(0.0, (clipDurationSec - clipT) / fadeOutSec)
            }
            if (extraFadeInSec > 0 && localT < extraFadeInSec) {
                env *= localT / extraFadeInSec
            }
            if (extraFadeOutSec > 0 && localT > segmentDurationSec - extraFadeOutSec) {
                env *= max(0.0, (segmentDurationSec - localT) / extraFadeOutSec)
            }
            val g = gain * env.toFloat()
            var ch = 0
            while (ch < channelCount) {
                val sample = inputBuffer.short.toInt()
                val scaled = (sample * g).roundToInt().coerceIn(-32768, 32767)
                output.putShort(scaled.toShort())
                ch++
            }
            frame++
        }
        inputBuffer.position(inputBuffer.limit())
        output.flip()
        framesSeen += frames
    }
}

/**
 * Tells Media3's DefaultVideoCompositor where each overlay
 * sequence goes, frame by frame: the plan's windows carry each
 * overlay clip's transform (scale and centre anchor as fractions
 * of the output frame) and crossfade heads ramp their alpha over
 * their window. Sequence 0 (the base track) is the identity;
 * sequences with no active window are fully transparent.
 */
@OptIn(UnstableApi::class)
class ExportCompositorSettings(
    private val outputWidth: Int,
    private val outputHeight: Int,
    private val windows: List<PlanWindow>
) : VideoCompositorSettings {

    override fun getOutputSize(inputSizes: List<Size>): Size {
        return Size(outputWidth, outputHeight)
    }

    override fun getOverlaySettings(sequenceIndex: Int, presentationTimeUs: Long): OverlaySettings {
        if (sequenceIndex == 0) {
            return StaticOverlaySettings.Builder().build()
        }
        val t = presentationTimeUs / 1000000.0
        val w = windows.firstOrNull {
            it.sequenceIndex == sequenceIndex && t >= it.startSec - 0.002 && t <= it.endSec + 0.002
        } ?: return StaticOverlaySettings.Builder().setAlphaScale(0f).build()
        var alpha = w.alpha
        if (w.fadeInSec > 0) {
            val p = ((t - w.startSec) / w.fadeInSec).coerceIn(0.0, 1.0)
            alpha *= p
        }
        return StaticOverlaySettings.Builder()
            .setScale(w.scaleX.toFloat(), w.scaleY.toFloat())
            .setBackgroundFrameAnchor(w.anchorX.toFloat(), w.anchorY.toFloat())
            .setOverlayFrameAnchor(0f, 0f)
            .setAlphaScale(alpha.toFloat())
            .setRotationDegrees(w.rotationDeg.toFloat())
            .build()
    }
}

class ExportCancelledException : Exception("Export cancelled")

data class ExportOutcome(
    val file: File,
    val notes: List<String>
)

/**
 * Media3 Transformer export of the project, driven by the pure
 * ExportPlanner plan (Phase 37): the base video track segmented
 * at text and junction boundaries, crossfade heads composited
 * over outgoing tails by the Media3 compositor, overlay video
 * tracks (picture-in-picture video and image clips) composited
 * with their transforms, per-clip speed (SpeedChangeEffect for
 * video, pitch-corrected Sonic for audio), per-clip gain and
 * audio fades, text overlays burned in at their project position,
 * size and colour, and every unmuted audio track mixed in at its
 * timeline position — rendered to a real MP4. Progress comes from
 * Transformer's own progress channel; cancellation calls
 * Transformer.cancel() and the partial file is deleted. What the
 * plan cannot express is reported in the outcome notes, never
 * silently pretended. Captions travel as a sidecar SRT written
 * by the caller.
 */
@OptIn(UnstableApi::class)
class VideoExporter(private val context: Context) {

    private var transformer: Transformer? = null
    private val handler = Handler(Looper.getMainLooper())

    @Volatile
    var progress: Float = 0f
        private set

    @Volatile
    private var cancelled = false

    fun cancel() {
        cancelled = true
        // The Transformer is bound to the application thread; cancel there.
        handler.post { transformer?.cancel() }
    }

    private fun buildItem(item: PlanItem, plan: ExportPlan): EditedMediaItem {
        val mediaBuilder = MediaItem.Builder().setUri(item.path)
        if (item.isImage) {
            mediaBuilder.setImageDurationMs((item.segmentDurationSec * 1000).toLong())
        } else {
            mediaBuilder.setClippingConfiguration(
                MediaItem.ClippingConfiguration.Builder()
                    .setStartPositionMs((item.sourceIn * 1000).toLong())
                    .setEndPositionMs((item.sourceOut * 1000).toLong())
                    .build()
            )
        }
        val audioProcessors = ArrayList<AudioProcessor>()
        if (item.hasAudio && !item.removeAudio) {
            if (item.speed != 1.0) {
                val sonic = SonicAudioProcessor()
                sonic.setSpeed(item.speed.toFloat())
                audioProcessors.add(sonic)
            }
            audioProcessors.add(
                ClipAudioProcessor(
                    item.gain.toFloat(),
                    item.fadeInSec,
                    item.fadeOutSec,
                    item.extraFadeInSec,
                    item.extraFadeOutSec,
                    item.clipDurationSec,
                    item.segmentOffsetSec,
                    item.segmentDurationSec
                )
            )
        }
        val videoEffects = ArrayList<androidx.media3.common.Effect>()
        if (!item.isImage && item.speed != 1.0) {
            videoEffects.add(SpeedChangeEffect(item.speed.toFloat()))
        }
        if (item.applyPresentation) {
            videoEffects.add(
                Presentation.createForWidthAndHeight(
                    plan.outputWidth, plan.outputHeight, Presentation.LAYOUT_SCALE_TO_FIT
                )
            )
        }
        if (item.texts.isNotEmpty()) {
            val overlays = ArrayList<TextureOverlay>()
            for (t in item.texts) {
                val span = SpannableString(t.text)
                val color = try {
                    Color.parseColor(t.colorHex)
                } catch (e: Exception) {
                    Color.WHITE
                }
                span.setSpan(ForegroundColorSpan(color), 0, span.length, 0)
                val settings = StaticOverlaySettings.Builder()
                    .setBackgroundFrameAnchor(
                        (t.xFrac * 2.0 - 1.0).toFloat(),
                        (1.0 - t.yFrac * 2.0).toFloat()
                    )
                    .setOverlayFrameAnchor(-1f, 1f)
                    .setScale(
                        (t.fontSize / 100.0).toFloat(),
                        (t.fontSize / 100.0).toFloat()
                    )
                    .setAlphaScale(t.opacity.toFloat())
                    .build()
                overlays.add(TextOverlay.createStaticTextOverlay(span, settings))
            }
            videoEffects.add(OverlayEffect(overlays))
        }
        return EditedMediaItem.Builder(mediaBuilder.build())
            .setEffects(Effects(audioProcessors, videoEffects))
            .setRemoveAudio(item.removeAudio)
            .build()
    }

    fun export(
        project: VideoProject,
        targetWidth: Int?,
        targetHeight: Int?,
        outputFile: File,
        onDone: (Result<ExportOutcome>) -> Unit
    ) {
        cancelled = false
        progress = 0f
        val plan = ExportPlanner.plan(project, targetWidth, targetHeight)
        if (plan.sequences.isEmpty()) {
            onDone(Result.failure(IllegalStateException("Nothing to export: the project has no exportable clips")))
            return
        }
        val sequences = ArrayList<EditedMediaItemSequence>()
        for (elements in plan.sequences) {
            val builder = EditedMediaItemSequence.Builder()
            for (element in elements) {
                when (element) {
                    is PlanElement.Gap -> builder.addGap((element.durationSec * 1000000).toLong())
                    is PlanElement.Item -> builder.addItem(buildItem(element.item, plan))
                }
            }
            sequences.add(builder.build())
        }
        val composition = Composition.Builder(sequences)
            .setVideoCompositorSettings(
                ExportCompositorSettings(plan.outputWidth, plan.outputHeight, plan.windows)
            )
            .build()
        // Media3's Transformer is bound to the application (main) thread:
        // it must be built and started there, whatever thread called export().
        handler.post {
            if (cancelled) {
                onDone(Result.failure(ExportCancelledException()))
                return@post
            }
            try {
                val built = Transformer.Builder(context)
                    .addListener(object : Transformer.Listener {
                        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                            progress = 1f
                            transformer = null
                            onDone(Result.success(ExportOutcome(outputFile, plan.notes)))
                        }

                        override fun onError(
                            composition: Composition,
                            exportResult: ExportResult,
                            exception: ExportException
                        ) {
                            transformer = null
                            if (cancelled) {
                                outputFile.delete()
                                onDone(Result.failure(ExportCancelledException()))
                            } else {
                                onDone(Result.failure(exception))
                            }
                        }
                    })
                    .build()
                transformer = built

                val poll = object : Runnable {
                    override fun run() {
                        val active = transformer ?: return
                        val holder = ProgressHolder()
                        val state = active.getProgress(holder)
                        if (state == Transformer.PROGRESS_STATE_AVAILABLE) {
                            progress = holder.progress / 100f
                        }
                        if (transformer != null) handler.postDelayed(this, 250)
                    }
                }
                handler.post(poll)
                built.start(composition, outputFile.absolutePath)
            } catch (e: Exception) {
                transformer = null
                onDone(Result.failure(e))
            }
        }
    }
}
`;
}


function editorViewModelKt(pkg: string): string {
  return `package ${pkg}.ui

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import ${pkg}.editor.EditorOps
import ${pkg}.editor.MediaAsset
import ${pkg}.editor.ProjectStore
import ${pkg}.editor.SquadForgeApi
import ${pkg}.editor.VideoProject
import ${pkg}.export.VideoExporter
import ${pkg}.player.PreviewPlayer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/**
 * Editor state and command layer. Every edit runs through EditorOps
 * (the same operation names/rules as the server engine), the result
 * is persisted immediately (ProjectStore) and the preview playlist
 * is rebuilt. Errors from invalid operations surface as a message,
 * never as a corrupted timeline.
 */
class EditorViewModel : ViewModel() {

    var project by mutableStateOf(EditorOps.createProject("Untitled Project"))
        private set
    var selectedClipId by mutableStateOf<String?>(null)
    var message by mutableStateOf<String?>(null)
    var playheadSec by mutableStateOf(0.0)
    var isPlaying by mutableStateOf(false)

    var exportRunning by mutableStateOf(false)
        private set
    var exportProgress by mutableStateOf(0f)
        private set
    var exportMessage by mutableStateOf<String?>(null)
        private set

    var serverBaseUrl by mutableStateOf("")
    var serverBuildId by mutableStateOf("")
    var serverCookie by mutableStateOf("")

    private var appContext: Context? = null
    private var store: ProjectStore? = null
    var previewPlayer: PreviewPlayer? = null
        private set
    private var exporter: VideoExporter? = null
    private var playheadJob: Job? = null

    fun attachContext(context: Context) {
        if (appContext != null) return
        appContext = context
        val projectStore = ProjectStore(context)
        store = projectStore
        val restored = projectStore.loadLast()
        if (restored != null) {
            project = restored
            message = "Recovered project '" + restored.name + "' from this device"
        }
        previewPlayer = PreviewPlayer(context)
        exporter = VideoExporter(context)
        val prefs = context.getSharedPreferences("clipforge_server", Context.MODE_PRIVATE)
        serverBaseUrl = prefs.getString("baseUrl", "") ?: ""
        serverBuildId = prefs.getString("buildId", "") ?: ""
        serverCookie = prefs.getString("cookie", "") ?: ""
        rebuildPreview()
    }

    private fun applyOp(label: String, op: (VideoProject) -> VideoProject) {
        try {
            project = op(project)
            message = null
            store?.save(project)
            rebuildPreview()
        } catch (e: IllegalArgumentException) {
            message = label + ": " + (e.message ?: "invalid operation")
        }
    }

    private fun rebuildPreview() {
        previewPlayer?.loadProject(project)
    }

    // -- Media import -------------------------------------------------------

    fun onMediaPicked(uris: List<Uri>, audioOnly: Boolean) {
        val context = appContext ?: return
        viewModelScope.launch {
            var added = 0
            for (uri in uris) {
                try {
                    context.contentResolver.takePersistableUriPermission(
                        uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
                    )
                } catch (e: Exception) {
                    // Photo-picker URIs carry their own long-lived grant.
                }
                val asset = withContext(Dispatchers.IO) { probe(context, uri, audioOnly) }
                if (asset != null) {
                    project = EditorOps.addMedia(project, asset)
                    added++
                }
            }
            if (added > 0) {
                store?.save(project)
                message = "Imported " + added + " asset(s)"
            } else {
                message = "Nothing could be imported from that selection"
            }
        }
    }

    private fun probe(context: Context, uri: Uri, audioOnly: Boolean): MediaAsset? {
        val mime = context.contentResolver.getType(uri) ?: ""
        val id = "media_" + UUID.randomUUID().toString().substring(0, 8)
        if (!audioOnly && mime.startsWith("image/")) {
            return MediaAsset(
                id = id, path = uri.toString(), durationSec = 0.0,
                hasVideo = true, hasAudio = false, kind = "image"
            )
        }
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(context, uri)
            val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull() ?: 0.0
            val hasVideo = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) == "yes"
            val hasAudio = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes"
            val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
            val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
            MediaAsset(
                id = id, path = uri.toString(), durationSec = durationMs / 1000.0,
                hasVideo = hasVideo, hasAudio = hasAudio,
                width = width, height = height,
                kind = if (audioOnly || !hasVideo) "audio" else "video"
            )
        } catch (e: Exception) {
            null
        } finally {
            retriever.release()
        }
    }

    // -- Editing commands ---------------------------------------------------

    fun addClipToTrack(trackId: String, mediaId: String) {
        val start = project.tracks.firstOrNull { it.id == trackId }
            ?.clips?.maxOfOrNull { it.trackEnd() } ?: 0.0
        applyOp("Add clip") { EditorOps.addClip(it, trackId, mediaId, start) }
    }

    fun addTrack(kind: String) = applyOp("Add track") { EditorOps.addTrack(it, kind) }
    fun trimIn(clipId: String, delta: Double) {
        val clip = findClip(clipId) ?: return
        applyOp("Trim") { EditorOps.trimClip(it, clipId, clip.sourceIn + delta, clip.sourceOut) }
    }
    fun trimOut(clipId: String, delta: Double) {
        val clip = findClip(clipId) ?: return
        applyOp("Trim") { EditorOps.trimClip(it, clipId, clip.sourceIn, clip.sourceOut + delta) }
    }
    fun splitAtPlayhead(clipId: String) =
        applyOp("Split") { EditorOps.splitClip(it, clipId, playheadSec) }
    fun moveClip(clipId: String, delta: Double) {
        val clip = findClip(clipId) ?: return
        applyOp("Move") { EditorOps.moveClip(it, clipId, clip.trackStart + delta) }
    }
    fun removeClip(clipId: String) {
        if (selectedClipId == clipId) selectedClipId = null
        applyOp("Delete") { EditorOps.removeClip(it, clipId) }
    }
    fun setClipVolume(clipId: String, volume: Double) =
        applyOp("Volume") { EditorOps.setClipVolume(it, clipId, volume) }
    fun setClipSpeed(clipId: String, speed: Double) =
        applyOp("Speed") { EditorOps.setClipSpeed(it, clipId, speed) }
    fun setTrackVolume(trackId: String, volume: Double) =
        applyOp("Track volume") { EditorOps.setTrackVolume(it, trackId, volume) }
    fun toggleTrackMuted(trackId: String) {
        val track = project.tracks.firstOrNull { it.id == trackId } ?: return
        applyOp("Mute") { EditorOps.setTrackMuted(it, trackId, track.muted != true) }
    }
    fun addTransition(afterClipId: String, type: String) =
        applyOp("Transition") { EditorOps.addTransition(it, afterClipId, type) }
    fun addText(text: String) =
        applyOp("Add text") { EditorOps.addText(it, text, playheadSec) }
    fun updateText(textId: String, text: String) =
        applyOp("Edit text") { EditorOps.updateText(it, textId, text) }
    fun removeText(textId: String) =
        applyOp("Remove text") { EditorOps.removeText(it, textId) }
    fun addCaption(text: String) =
        applyOp("Add caption") { EditorOps.addCaption(it, playheadSec, playheadSec + 2.0, text) }
    fun removeCaption(captionId: String) =
        applyOp("Remove caption") { EditorOps.removeCaption(it, captionId) }

    fun findClip(clipId: String) = project.tracks.flatMap { it.clips }.firstOrNull { it.id == clipId }

    // -- Playback -----------------------------------------------------------

    fun togglePlay() {
        val player = previewPlayer ?: return
        if (isPlaying) {
            player.pause()
            isPlaying = false
            playheadJob?.cancel()
        } else {
            player.play()
            isPlaying = true
            playheadJob = viewModelScope.launch {
                while (true) {
                    playheadSec = player.videoPlayer.currentPosition / 1000.0
                    delay(200)
                }
            }
        }
    }

    fun seekTo(sec: Double) {
        playheadSec = sec
        previewPlayer?.seekTo((sec * 1000).toLong())
    }

    // -- Export -------------------------------------------------------------

    fun startExport(resolutionLabel: String) {
        val context = appContext ?: return
        val exp = exporter ?: return
        if (exportRunning) return
        val target = when (resolutionLabel) {
            "480p" -> 480
            "720p" -> 720
            "1080p" -> 1080
            else -> null
        }
        val scale = if (target == null || project.height == 0) 1.0 else target.toDouble() / project.height
        val targetWidth = if (target == null) null else (project.width * scale).toInt()
        val targetHeight = target
        val dir = File(context.getExternalFilesDir(android.os.Environment.DIRECTORY_MOVIES), "exports").apply { mkdirs() }
        val output = File(dir, project.name.replace(Regex("[^A-Za-z0-9_-]"), "_") + "_" + System.currentTimeMillis() + ".mp4")
        exportRunning = true
        exportProgress = 0f
        exportMessage = null
        viewModelScope.launch {
            while (exportRunning) {
                exportProgress = exp.progress
                delay(250)
            }
        }
        exp.export(project, targetWidth, targetHeight, output) { result ->
            exportRunning = false
            result.fold(
                onSuccess = { outcome ->
                    val srt = File(outcome.file.parentFile, outcome.file.nameWithoutExtension + ".srt")
                    if (project.captions.isNotEmpty()) {
                        srt.writeText(EditorOps.captionsToSrt(project))
                    }
                    exportProgress = 1f
                    exportMessage = "Exported to " + outcome.file.absolutePath +
                        (if (project.captions.isNotEmpty()) " with captions at " + srt.name else "") +
                        if (outcome.notes.isNotEmpty()) "\\nNotes: " + outcome.notes.joinToString("; ") else ""
                },
                onFailure = { error ->
                    exportMessage = if (error is ${pkg}.export.ExportCancelledException) {
                        "Export cancelled"
                    } else {
                        "Export failed: " + (error.message ?: "unknown error")
                    }
                }
            )
        }
    }

    fun cancelExport() {
        exporter?.cancel()
    }

    // -- SquadForge server connection ----------------------------------------

    private fun api(): SquadForgeApi? {
        if (serverBaseUrl.isBlank() || serverBuildId.isBlank()) {
            message = "Set the server URL and build id first"
            return null
        }
        val context = appContext ?: return null
        val prefs = context.getSharedPreferences("clipforge_server", Context.MODE_PRIVATE)
        prefs.edit().putString("baseUrl", serverBaseUrl).putString("buildId", serverBuildId)
            .putString("cookie", serverCookie).apply()
        return SquadForgeApi(serverBaseUrl, serverBuildId, serverCookie)
    }

    fun loadFromServer() {
        val api = api() ?: return
        viewModelScope.launch {
            try {
                val loaded = withContext(Dispatchers.IO) { api.loadProject() }
                project = loaded
                store?.save(project)
                rebuildPreview()
                message = "Loaded project '" + loaded.name + "' from the server"
            } catch (e: Exception) {
                message = "Server load failed: " + (e.message ?: "unknown error")
            }
        }
    }

    fun saveToServer() {
        val api = api() ?: return
        val snapshot = project
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { api.saveProject(snapshot) }
                message = "Saved to the server"
            } catch (e: Exception) {
                message = "Server save failed: " + (e.message ?: "unknown error")
            }
        }
    }

    override fun onCleared() {
        previewPlayer?.release()
        super.onCleared()
    }
}
`;
}

function editorScreenKt(pkg: string): string {
  return `package ${pkg}.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.ui.PlayerView
import kotlin.math.roundToInt

private fun fmt(sec: Double): String {
    val total = sec.roundToInt()
    return (total / 60).toString() + ":" + (total % 60).toString().padStart(2, '0')
}

/**
 * The native editor screen. Every control is wired to a real
 * EditorViewModel command (which runs the genuine EditorOps and
 * persists the result); there are no decorative buttons.
 */
@Composable
fun EditorScreen(viewModel: EditorViewModel) {
    val project = viewModel.project
    var textDraft by remember { mutableStateOf("") }
    var captionDraft by remember { mutableStateOf("") }
    var resolution by remember { mutableStateOf("Source") }

    val visualPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(10)
    ) { uris -> viewModel.onMediaPicked(uris, false) }
    val audioPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris -> viewModel.onMediaPicked(uris, true) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Text(project.name, style = MaterialTheme.typography.titleLarge)
        viewModel.message?.let { Text(it, color = MaterialTheme.colorScheme.primary) }

        // -- Preview ------------------------------------------------------
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(220.dp)
                .background(Color.Black)
        ) {
            AndroidView(
                factory = { ctx ->
                    PlayerView(ctx).apply {
                        this.player = viewModel.previewPlayer?.videoPlayer
                        useController = false
                    }
                },
                modifier = Modifier.fillMaxWidth().height(220.dp)
            )
            Column(modifier = Modifier.padding(8.dp)) {
                for (text in project.texts) {
                    if (viewModel.playheadSec >= text.trackStart && viewModel.playheadSec < text.trackEnd()) {
                        Text(text.text, color = Color.White, style = MaterialTheme.typography.titleMedium)
                    }
                }
            }
            val activeCaption = project.captions.firstOrNull {
                viewModel.playheadSec >= it.startSec && viewModel.playheadSec < it.endSec
            }
            if (activeCaption != null) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 188.dp)
                        .background(Color(0xAA000000))
                        .padding(4.dp)
                ) {
                    Text(activeCaption.text, color = Color.White)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { viewModel.togglePlay() }) {
                Text(if (viewModel.isPlaying) "Pause" else "Play")
            }
            Text(fmt(viewModel.playheadSec) + " / " + fmt(project.duration()))
        }
        Slider(
            value = viewModel.playheadSec.toFloat()
                .coerceIn(0f, project.duration().toFloat().coerceAtLeast(1f)),
            onValueChange = { viewModel.seekTo(it.toDouble()) },
            valueRange = 0f..project.duration().toFloat().coerceAtLeast(1f)
        )

        // -- Media library --------------------------------------------------
        Text("Media", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = {
                visualPicker.launch(
                    PickVisualMediaRequest.Builder()
                        .setMediaType(ActivityResultContracts.PickVisualMedia.ImageAndVideo)
                        .build()
                )
            }) { Text("Add video / image") }
            Button(onClick = { audioPicker.launch(arrayOf("audio/*")) }) { Text("Add audio") }
        }
        for (asset in project.media) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text(
                    asset.mediaKind() + " · " + fmt(asset.durationSec),
                    modifier = Modifier.weight(1f)
                )
                val target = project.tracks.firstOrNull {
                    (asset.mediaKind() == "audio" && it.kind == "audio") ||
                        (asset.mediaKind() != "audio" && it.kind == "video")
                }
                if (target != null) {
                    OutlinedButton(onClick = { viewModel.addClipToTrack(target.id, asset.id) }) {
                        Text("Add to " + target.name)
                    }
                }
            }
        }

        // -- Timeline -------------------------------------------------------
        Text("Timeline", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { viewModel.addTrack("video") }) { Text("+ Video track") }
            OutlinedButton(onClick = { viewModel.addTrack("audio") }) { Text("+ Audio track") }
        }
        for (track in project.tracks) {
            Text(track.name + " (" + track.kind + ")", style = MaterialTheme.typography.labelLarge)
            if (track.kind == "audio") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Slider(
                        value = (track.volume ?: 1.0).toFloat(),
                        onValueChange = { viewModel.setTrackVolume(track.id, it.toDouble()) },
                        valueRange = 0f..2f,
                        modifier = Modifier.weight(1f)
                    )
                    TextButton(onClick = { viewModel.toggleTrackMuted(track.id) }) {
                        Text(if (track.muted == true) "Unmute" else "Mute")
                    }
                }
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                for (clip in track.clips) {
                    val selected = viewModel.selectedClipId == clip.id
                    Box(
                        modifier = Modifier
                            .width((clip.duration() * 22).dp.coerceIn(56.dp, 340.dp))
                            .height(44.dp)
                            .background(if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.secondary)
                            .clickable { viewModel.selectedClipId = clip.id }
                            .padding(6.dp)
                    ) {
                        Text(fmt(clip.duration()), color = Color.White)
                    }
                }
            }
        }

        // -- Selected clip ----------------------------------------------------
        val selectedClip = viewModel.selectedClipId?.let { viewModel.findClip(it) }
        if (selectedClip != null) {
            Text("Selected clip", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedButton(onClick = { viewModel.splitAtPlayhead(selectedClip.id) }) { Text("Split at playhead") }
                OutlinedButton(onClick = { viewModel.removeClip(selectedClip.id) }) { Text("Delete") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedButton(onClick = { viewModel.moveClip(selectedClip.id, -0.5) }) { Text("Move -0.5s") }
                OutlinedButton(onClick = { viewModel.moveClip(selectedClip.id, 0.5) }) { Text("Move +0.5s") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedButton(onClick = { viewModel.trimIn(selectedClip.id, 0.5) }) { Text("Trim in +0.5s") }
                OutlinedButton(onClick = { viewModel.trimIn(selectedClip.id, -0.5) }) { Text("Trim in -0.5s") }
                OutlinedButton(onClick = { viewModel.trimOut(selectedClip.id, 0.5) }) { Text("Trim out +0.5s") }
                OutlinedButton(onClick = { viewModel.trimOut(selectedClip.id, -0.5) }) { Text("Trim out -0.5s") }
            }
            Text("Volume")
            Slider(
                value = selectedClip.volume.toFloat(),
                onValueChange = { viewModel.setClipVolume(selectedClip.id, it.toDouble()) },
                valueRange = 0f..1f
            )
            Text("Speed")
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (speed in listOf(0.5, 1.0, 1.5, 2.0)) {
                    FilterChip(
                        selected = selectedClip.speedOrDefault() == speed,
                        onClick = { viewModel.setClipSpeed(selectedClip.id, speed) },
                        label = { Text(speed.toString() + "x") }
                    )
                }
            }
            Text("Transition after this clip")
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (type in listOf("crossfade", "fade-black", "wipe-left")) {
                    OutlinedButton(onClick = { viewModel.addTransition(selectedClip.id, type) }) {
                        Text(type)
                    }
                }
            }
        }

        // -- Text overlays ----------------------------------------------------
        Text("Text overlays", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = textDraft,
                onValueChange = { textDraft = it },
                label = { Text("Overlay text") },
                modifier = Modifier.weight(1f)
            )
            Button(onClick = {
                if (textDraft.isNotBlank()) {
                    viewModel.addText(textDraft)
                    textDraft = ""
                }
            }) { Text("Add at playhead") }
        }
        for (text in project.texts) {
            Row(modifier = Modifier.fillMaxWidth()) {
                Text(
                    "\\"" + text.text + "\\" @ " + fmt(text.trackStart),
                    modifier = Modifier.weight(1f)
                )
                TextButton(onClick = { viewModel.removeText(text.id) }) { Text("Remove") }
            }
        }

        // -- Captions ---------------------------------------------------------
        Text("Captions", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = captionDraft,
                onValueChange = { captionDraft = it },
                label = { Text("Caption text") },
                modifier = Modifier.weight(1f)
            )
            Button(onClick = {
                if (captionDraft.isNotBlank()) {
                    viewModel.addCaption(captionDraft)
                    captionDraft = ""
                }
            }) { Text("Add at playhead") }
        }
        for (cue in project.captions) {
            Row(modifier = Modifier.fillMaxWidth()) {
                Text(
                    fmt(cue.startSec) + " " + cue.text,
                    modifier = Modifier.weight(1f)
                )
                TextButton(onClick = { viewModel.removeCaption(cue.id) }) { Text("Remove") }
            }
        }

        // -- Export -----------------------------------------------------------
        Text("Export", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (label in listOf("Source", "480p", "720p", "1080p")) {
                FilterChip(
                    selected = resolution == label,
                    onClick = { resolution = label },
                    label = { Text(label) }
                )
            }
        }
        if (viewModel.exportRunning) {
            LinearProgressIndicator(progress = viewModel.exportProgress, modifier = Modifier.fillMaxWidth())
            OutlinedButton(onClick = { viewModel.cancelExport() }) { Text("Cancel export") }
        } else {
            Button(onClick = { viewModel.startExport(resolution) }) { Text("Export MP4") }
        }
        viewModel.exportMessage?.let { Text(it) }

        // -- SquadForge server --------------------------------------------------
        Text("SquadForge server (optional)", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = viewModel.serverBaseUrl,
            onValueChange = { viewModel.serverBaseUrl = it },
            label = { Text("Server base URL") },
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = viewModel.serverBuildId,
            onValueChange = { viewModel.serverBuildId = it },
            label = { Text("Build id") },
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = viewModel.serverCookie,
            onValueChange = { viewModel.serverCookie = it },
            label = { Text("Session cookie (your own, stored on device only)") },
            modifier = Modifier.fillMaxWidth()
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { viewModel.loadFromServer() }) { Text("Load project") }
            Button(onClick = { viewModel.saveToServer() }) { Text("Save project") }
        }
        Spacer(modifier = Modifier.height(24.dp))
    }
}
`;
}

function exportPlannerTestKt(pkg: string): string {
  return `package ${pkg}

import ${pkg}.editor.ClipTransform
import ${pkg}.editor.MediaAsset
import ${pkg}.editor.TextElement
import ${pkg}.editor.TimelineClip
import ${pkg}.editor.TimelineTrack
import ${pkg}.editor.Transition
import ${pkg}.editor.VideoProject
import ${pkg}.export.ExportPlanner
import ${pkg}.export.PlanElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Phase 37: JVM tests for the pure export planner — the plan is
 * what the Media3 exporter renders, so sequence structure, gaps,
 * crossfade heads, speed, fades, transform windows and text
 * attachment are all verified here without a device. The genuine
 * on-device render is proven separately by ExportParityTest.
 */
class ExportPlannerTest {

    private fun asset(id: String, kind: String, w: Int? = 640, h: Int? = 360): MediaAsset {
        return MediaAsset(
            id = id, path = "/media/" + id + ".mp4", durationSec = 10.0,
            hasVideo = kind == "video", hasAudio = kind != "image",
            width = w, height = h, kind = kind
        )
    }

    private fun project(
        tracks: List<TimelineTrack>,
        media: List<MediaAsset>,
        transitions: List<Transition> = emptyList(),
        texts: List<TextElement> = emptyList()
    ): VideoProject {
        return VideoProject(
            id = "p", name = "T", width = 640, height = 360, fps = 30.0,
            tracks = tracks, media = media, transitions = transitions, texts = texts
        )
    }

    private fun items(seq: List<PlanElement>): List<${pkg}.export.PlanItem> {
        return seq.filterIsInstance<PlanElement.Item>().map { it.item }
    }

    private fun gaps(seq: List<PlanElement>): List<Double> {
        return seq.filterIsInstance<PlanElement.Gap>().map { it.durationSec }
    }

    @Test
    fun crossfadeSplitsIncomingClipIntoCompositedHead() {
        val a = TimelineClip("a", "v1", 0.0, 0.0, 4.0)
        val b = TimelineClip("b", "v2", 4.0, 0.0, 4.0)
        val p = project(
            listOf(TimelineTrack("t", "video", "Base", listOf(a, b))),
            listOf(asset("v1", "video"), asset("v2", "video")),
            transitions = listOf(Transition("a", "crossfade", 1.0))
        )
        val plan = ExportPlanner.plan(p, null, null)
        assertEquals(2, plan.sequences.size)
        val baseItems = items(plan.sequences[0])
        assertEquals(3, baseItems.size)
        assertEquals(3.0, baseItems[0].segmentDurationSec, 0.001)
        assertEquals(1.0, baseItems[1].segmentDurationSec, 0.001)
        assertEquals(1.0, baseItems[1].extraFadeOutSec, 0.001)
        assertEquals(1.0, baseItems[2].sourceIn, 0.001)
        assertEquals(3.0, baseItems[2].segmentDurationSec, 0.001)
        val headSeq = plan.sequences[1]
        assertEquals(listOf(3.0), gaps(headSeq))
        val head = items(headSeq).single()
        assertEquals(0.0, head.sourceIn, 0.001)
        assertEquals(1.0, head.segmentDurationSec, 0.001)
        assertEquals(1.0, head.extraFadeInSec, 0.001)
        val window = plan.windows.single()
        assertEquals(1, window.sequenceIndex)
        assertEquals(3.0, window.startSec, 0.001)
        assertEquals(4.0, window.endSec, 0.001)
        assertEquals(1.0, window.fadeInSec, 0.001)
        assertEquals(7.0, plan.totalDurationSec, 0.001)
        assertTrue(plan.notes.isEmpty())
    }

    @Test
    fun unsupportedTransitionTypeRendersAsCutWithNote() {
        val a = TimelineClip("a", "v1", 0.0, 0.0, 4.0)
        val b = TimelineClip("b", "v2", 4.0, 0.0, 4.0)
        val p = project(
            listOf(TimelineTrack("t", "video", "Base", listOf(a, b))),
            listOf(asset("v1", "video"), asset("v2", "video")),
            transitions = listOf(Transition("a", "wipe-left", 1.0))
        )
        val plan = ExportPlanner.plan(p, null, null)
        assertEquals(1, plan.sequences.size)
        assertEquals(8.0, plan.totalDurationSec, 0.001)
        assertTrue(plan.notes.any { it.contains("wipe-left") && it.contains("render as cuts") })
    }

    @Test
    fun speedHalvesTimelineDurationAndIsCarriedOnItem() {
        val a = TimelineClip("a", "v1", 0.0, 0.0, 4.0, speed = 2.0)
        val p = project(
            listOf(TimelineTrack("t", "video", "Base", listOf(a))),
            listOf(asset("v1", "video"))
        )
        val plan = ExportPlanner.plan(p, null, null)
        val item = items(plan.sequences[0]).single()
        assertEquals(2.0, item.speed, 0.001)
        assertEquals(2.0, item.segmentDurationSec, 0.001)
        assertEquals(2.0, plan.totalDurationSec, 0.001)
    }

    @Test
    fun fadesAreCarriedWithClipRelativeOffsetsAfterTextSplit() {
        val a = TimelineClip("a", "v1", 0.0, 0.0, 4.0, fadeInSec = 0.5, fadeOutSec = 1.0)
        val text = TextElement("x", "Hi", 1.0, 1.0, 40.0, 40.0, 48.0, "#FFFFFF", null)
        val p = project(
            listOf(TimelineTrack("t", "video", "Base", listOf(a))),
            listOf(asset("v1", "video")),
            texts = listOf(text)
        )
        val plan = ExportPlanner.plan(p, null, null)
        val segs = items(plan.sequences[0])
        assertEquals(3, segs.size)
        assertEquals(1.0, segs[1].segmentOffsetSec, 0.001)
        for (seg in segs) {
            assertEquals(0.5, seg.fadeInSec, 0.001)
            assertEquals(1.0, seg.fadeOutSec, 0.001)
        }
    }

    @Test
    fun overlayTrackIsGapPositionedWithTransformWindow() {
        val base = TimelineClip("a", "v1", 0.0, 0.0, 6.0)
        val ov = TimelineClip(
            "o", "v2", 2.0, 0.0, 3.0,
            transform = ClipTransform(100.0, 50.0, 2.0, 15.0, 0.5)
        )
        val p = project(
            listOf(
                TimelineTrack("t", "video", "Base", listOf(base)),
                TimelineTrack("t2", "video", "PiP", listOf(ov))
            ),
            listOf(asset("v1", "video"), asset("v2", "video", 160, 120))
        )
        val plan = ExportPlanner.plan(p, null, null)
        assertEquals(2, plan.sequences.size)
        assertEquals(listOf(2.0), gaps(plan.sequences[1]))
        val w = plan.windows.single()
        assertEquals(1, w.sequenceIndex)
        assertEquals(2.0, w.startSec, 0.001)
        assertEquals(5.0, w.endSec, 0.001)
        assertEquals(0.5, w.scaleX, 0.001)
        assertEquals(240.0 / 360.0, w.scaleY, 0.001)
        assertEquals(-0.1875, w.anchorX, 0.001)
        assertEquals(1.0 - 170.0 / 360.0 * 2.0, w.anchorY, 0.001)
        assertEquals(0.5, w.alpha, 0.001)
        assertEquals(15.0, w.rotationDeg, 0.001)
    }

    @Test
    fun imageClipOnOverlayTrackBecomesImageItem() {
        val base = TimelineClip("a", "v1", 0.0, 0.0, 6.0)
        val img = TimelineClip("i", "im", 1.0, 0.0, 2.0)
        val p = project(
            listOf(
                TimelineTrack("t", "video", "Base", listOf(base)),
                TimelineTrack("t2", "video", "PiP", listOf(img))
            ),
            listOf(asset("v1", "video"), asset("im", "image", 200, 100))
        )
        val plan = ExportPlanner.plan(p, null, null)
        val item = items(plan.sequences[1]).single()
        assertTrue(item.isImage)
        assertEquals(2.0, item.segmentDurationSec, 0.001)
    }

    @Test
    fun imageClipOnBaseTrackIsExportedAsImageItem() {
        val img = TimelineClip("i", "im", 0.0, 0.0, 3.0)
        val p = project(
            listOf(TimelineTrack("t", "video", "Base", listOf(img))),
            listOf(asset("im", "image", 200, 100))
        )
        val plan = ExportPlanner.plan(p, null, null)
        val item = items(plan.sequences[0]).single()
        assertTrue(item.isImage)
        assertEquals(3.0, plan.totalDurationSec, 0.001)
    }

    @Test
    fun audioTrackClipsAreGapPositionedWithCombinedGainAndMuteRespected() {
        val base = TimelineClip("a", "v1", 0.0, 0.0, 6.0)
        val mus = TimelineClip("m", "au", 3.0, 0.0, 2.0, volume = 0.5)
        val mutedClip = TimelineClip("m2", "au", 0.0, 0.0, 2.0)
        val p = project(
            listOf(
                TimelineTrack("t", "video", "Base", listOf(base)),
                TimelineTrack("ta", "audio", "Music", listOf(mus), volume = 0.8),
                TimelineTrack("tm", "audio", "Muted", listOf(mutedClip), muted = true)
            ),
            listOf(asset("v1", "video"), asset("au", "audio"))
        )
        val plan = ExportPlanner.plan(p, null, null)
        assertEquals(2, plan.sequences.size)
        assertEquals(listOf(3.0), gaps(plan.sequences[1]))
        val item = items(plan.sequences[1]).single()
        assertEquals(0.4, item.gain, 0.001)
    }

    @Test
    fun textAttachesOnlyToOverlappingSegmentsWithProjectFractions() {
        val a = TimelineClip("a", "v1", 0.0, 0.0, 4.0)
        val text = TextElement("x", "Mid", 1.0, 1.0, 320.0, 180.0, 48.0, "#FF0000", 0.75)
        val p = project(
            listOf(TimelineTrack("t", "video", "Base", listOf(a))),
            listOf(asset("v1", "video")),
            texts = listOf(text)
        )
        val plan = ExportPlanner.plan(p, null, null)
        val segs = items(plan.sequences[0])
        assertEquals(3, segs.size)
        assertTrue(segs[0].texts.isEmpty())
        assertEquals(1, segs[1].texts.size)
        assertTrue(segs[2].texts.isEmpty())
        val attached = segs[1].texts.single()
        assertEquals(0.5, attached.xFrac, 0.001)
        assertEquals(0.5, attached.yFrac, 0.001)
        assertEquals("#FF0000", attached.colorHex)
        assertEquals(0.75, attached.opacity, 0.001)
    }

    @Test
    fun emptyProjectYieldsNoSequences() {
        val plan = ExportPlanner.plan(project(emptyList(), emptyList()), null, null)
        assertTrue(plan.sequences.isEmpty())
        assertEquals(0.0, plan.totalDurationSec, 0.001)
    }

    @Test
    fun crossfadeLongerThanHalfTheShorterClipIsClamped() {
        val a = TimelineClip("a", "v1", 0.0, 0.0, 1.0)
        val b = TimelineClip("b", "v2", 1.0, 0.0, 4.0)
        val p = project(
            listOf(TimelineTrack("t", "video", "Base", listOf(a, b))),
            listOf(asset("v1", "video"), asset("v2", "video")),
            transitions = listOf(Transition("a", "crossfade", 2.0))
        )
        val plan = ExportPlanner.plan(p, null, null)
        assertEquals(4.5, plan.totalDurationSec, 0.001)
        val window = plan.windows.single()
        assertEquals(0.5, window.endSec - window.startSec, 0.001)
    }
}
`;
}

function exportParityTestKt(pkg: string): string {
  return `package ${pkg}

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import ${pkg}.editor.ClipTransform
import ${pkg}.editor.MediaAsset
import ${pkg}.editor.TextElement
import ${pkg}.editor.TimelineClip
import ${pkg}.editor.TimelineTrack
import ${pkg}.editor.Transition
import ${pkg}.editor.VideoProject
import ${pkg}.export.ExportOutcome
import ${pkg}.export.VideoExporter
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Phase 37: genuine on-device export test. The CI harness places
 * synthetic media (solid-colour clips with known geometry, a tone
 * with known fades) into the test APK's assets; this test builds a
 * project exercising every Phase 37 export feature — a crossfade,
 * a 2x speed clip, a picture-in-picture overlay with a transform,
 * an image overlay, audio fades and a burned-in text element —
 * runs the app's real Media3 export, and leaves the MP4 in the
 * app's external files directory for the harness to pull and
 * verify with ffprobe and pixel/audio measurements.
 */
@RunWith(AndroidJUnit4::class)
class ExportParityTest {

    private fun copyAsset(context: Context, name: String, dir: File): File {
        val out = File(dir, name)
        context.assets.open("exporttest/" + name).use { input ->
            out.outputStream().use { output -> input.copyTo(output) }
        }
        return out
    }

    @Test
    fun exportParityEndToEnd() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val appContext = instrumentation.targetContext
        val testContext = instrumentation.context
        val workDir = File(appContext.cacheDir, "exporttest")
        workDir.mkdirs()
        val clipA = copyAsset(testContext, "clipA.mp4", workDir)
        val clipB = copyAsset(testContext, "clipB.mp4", workDir)
        val overlay = copyAsset(testContext, "overlay.mp4", workDir)
        val image = copyAsset(testContext, "image.png", workDir)
        val music = copyAsset(testContext, "music.mp4", workDir)

        val media = listOf(
            MediaAsset("mA", clipA.absolutePath, 4.0, true, true, 640, 360, "video"),
            MediaAsset("mB", clipB.absolutePath, 4.0, true, true, 640, 360, "video"),
            MediaAsset("mOv", overlay.absolutePath, 3.0, true, false, 160, 120, "video"),
            MediaAsset("mImg", image.absolutePath, 0.6, false, false, 200, 100, "image"),
            MediaAsset("mMus", music.absolutePath, 6.0, false, true, null, null, "audio")
        )
        val baseTrack = TimelineTrack(
            "tBase", "video", "Base",
            listOf(
                TimelineClip(id = "clipA", mediaId = "mA", trackStart = 0.0, sourceIn = 0.0, sourceOut = 4.0),
                TimelineClip(id = "clipB", mediaId = "mB", trackStart = 4.0, sourceIn = 0.0, sourceOut = 4.0, speed = 2.0)
            )
        )
        val overlayTrack = TimelineTrack(
            "tOv", "video", "Overlay",
            listOf(
                TimelineClip(
                    id = "clipOv", mediaId = "mOv", trackStart = 1.0, sourceIn = 0.0, sourceOut = 3.0,
                    transform = ClipTransform(400.0, 200.0, 1.0, 0.0, 1.0)
                ),
                TimelineClip(
                    id = "clipImg", mediaId = "mImg", trackStart = 5.4, sourceIn = 0.0, sourceOut = 0.6,
                    transform = ClipTransform(40.0, 220.0, 1.0, 0.0, 1.0)
                )
            )
        )
        val audioTrack = TimelineTrack(
            "tAu", "audio", "Music",
            listOf(
                TimelineClip(
                    id = "clipMus", mediaId = "mMus", trackStart = 0.0, sourceIn = 0.0, sourceOut = 5.0,
                    fadeInSec = 1.0, fadeOutSec = 1.0
                )
            )
        )
        val project = VideoProject(
            id = "parity", name = "Export Parity", width = 640, height = 360, fps = 30.0,
            tracks = listOf(baseTrack, overlayTrack, audioTrack),
            media = media,
            transitions = listOf(Transition("clipA", "crossfade", 1.0)),
            texts = listOf(
                TextElement("txt1", "HELLO", 0.5, 2.5, 40.0, 40.0, 48.0, "#FFFFFF", null)
            ),
            captions = emptyList()
        )

        val outDir = appContext.getExternalFilesDir(null) ?: appContext.filesDir
        val output = File(outDir, "export_parity_output.mp4")
        if (output.exists()) output.delete()
        val latch = CountDownLatch(1)
        var outcome: Result<ExportOutcome>? = null
        val exporter = VideoExporter(appContext)
        exporter.export(project, null, null, output) { result ->
            outcome = result
            latch.countDown()
        }
        assertTrue("export timed out after 300s", latch.await(300, TimeUnit.SECONDS))
        assertTrue("no export outcome", outcome != null)
        val result = outcome!!
        if (result.isFailure) {
            throw AssertionError("export failed: " + result.exceptionOrNull())
        }
        assertTrue("output file missing", output.exists())
        assertTrue("output suspiciously small: " + output.length(), output.length() > 20000)
        val notes = result.getOrThrow().notes.joinToString(" | ")
        File(outDir, "export_parity_result.txt").writeText(
            "bytes=" + output.length() + " notes=" + notes
        )
    }
}
`;
}


function editorOpsTestKt(pkg: string): string {
  return `package ${pkg}

import ${pkg}.editor.EditorOps
import ${pkg}.editor.MediaAsset
import ${pkg}.editor.VideoProject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Local JVM unit tests for the editor's pure operations — the same
 * behaviours the SquadForge server engine guarantees (Phases 20/26):
 * overlap rejection, trim clamping, split math, speed validation,
 * JSON round-trip and SRT formatting.
 */
class EditorOpsTest {

    private fun projectWithClip(): VideoProject {
        var project = EditorOps.createProject("Test")
        project = EditorOps.addMedia(
            project,
            MediaAsset(id = "m1", path = "content://media/1", durationSec = 10.0, hasVideo = true, hasAudio = true, kind = "video")
        )
        val trackId = project.tracks.first { it.kind == "video" }.id
        project = EditorOps.addClip(project, trackId, "m1", 0.0)
        return project
    }

    @Test
    fun addClipRejectsOverlap() {
        val project = projectWithClip()
        val trackId = project.tracks.first { it.kind == "video" }.id
        try {
            EditorOps.addClip(project, trackId, "m1", 5.0)
            fail("overlapping addClip must throw")
        } catch (expected: IllegalArgumentException) {
            assertTrue(expected.message!!.contains("overlap"))
        }
    }

    @Test
    fun trimClampsToMediaDuration() {
        val project = projectWithClip()
        val clip = project.tracks.first { it.kind == "video" }.clips.first()
        val trimmed = EditorOps.trimClip(project, clip.id, -5.0, 99.0)
        val result = trimmed.tracks.first { it.kind == "video" }.clips.first()
        assertEquals(0.0, result.sourceIn, 1e-9)
        assertEquals(10.0, result.sourceOut, 1e-9)
    }

    @Test
    fun splitProducesTwoClipsCoveringTheOriginalSpan() {
        val project = projectWithClip()
        val clip = project.tracks.first { it.kind == "video" }.clips.first()
        val split = EditorOps.splitClip(project, clip.id, 4.0)
        val clips = split.tracks.first { it.kind == "video" }.clips.sortedBy { it.trackStart }
        assertEquals(2, clips.size)
        assertEquals(4.0, clips[0].duration(), 1e-9)
        assertEquals(6.0, clips[1].duration(), 1e-9)
        assertEquals(4.0, clips[1].sourceIn, 1e-9)
    }

    @Test
    fun volumeAndSpeedAreClamped() {
        val project = projectWithClip()
        val clip = project.tracks.first { it.kind == "video" }.clips.first()
        val loud = EditorOps.setClipVolume(project, clip.id, 7.0)
        assertEquals(1.0, loud.tracks.first { it.kind == "video" }.clips.first().volume, 1e-9)
        val fast = EditorOps.setClipSpeed(project, clip.id, 99.0)
        assertEquals(4.0, fast.tracks.first { it.kind == "video" }.clips.first().speedOrDefault(), 1e-9)
    }

    @Test
    fun jsonRoundTripPreservesTheProject() {
        var project = projectWithClip()
        project = EditorOps.addText(project, "Hello", 1.0, 2.0)
        project = EditorOps.addCaption(project, 0.5, 2.5, "First line")
        val restored = VideoProject.fromJson(project.toJson())
        assertEquals(project.id, restored.id)
        assertEquals(1, restored.tracks.first { it.kind == "video" }.clips.size)
        assertEquals("Hello", restored.texts.first().text)
        assertEquals("First line", restored.captions.first().text)
        assertEquals(project.duration(), restored.duration(), 1e-9)
    }

    @Test
    fun srtFormattingMatchesTheServerShape() {
        var project = EditorOps.createProject("Caps")
        project = EditorOps.addCaption(project, 0.5, 2.5, "First line")
        val srt = EditorOps.captionsToSrt(project)
        assertTrue(srt.contains("1\\n00:00:00,500 --> 00:00:02,500\\nFirst line"))
    }
}
`;
}
