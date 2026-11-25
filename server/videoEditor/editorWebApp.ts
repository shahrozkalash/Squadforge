/**
 * Phase 31: the web-based editor application.
 *
 * A single self-contained page served per build at
 * `GET /api/builds/:id/video-editor/app`. Every control on it calls
 * the real video-editor API for that build — media import/probe,
 * editing operations, server-rendered preview frames, playback info,
 * waveforms, analysis, captions, exports and render jobs. There are
 * no decorative controls: if a button exists, it performs the named
 * operation against the engine and surfaces the server's error when
 * it fails.
 *
 * Preview "playback" steps through REAL frames rendered on demand by
 * the Phase 27 preview engine (actual decoding, the exporter's own
 * compositing chain). The achieved frame rate depends on project
 * size and host speed; the UI never fakes frames between renders.
 */
export const EDITOR_WEB_APP_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClipForge Web Editor — SquadForge</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, Segoe UI, Arial, sans-serif; background: #14161a; color: #e8eaed; }
  header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 14px; background: #1c1f26; border-bottom: 1px solid #2c303a; }
  header h1 { font-size: 16px; margin: 0 12px 0 0; }
  header .spacer { flex: 1; }
  #statusLine { font-size: 12px; color: #9fb0c3; }
  #errorBar { display: none; background: #5a1f1f; color: #ffd7d7; padding: 8px 14px; font-size: 13px; }
  main { display: grid; grid-template-columns: 280px 1fr 300px; gap: 10px; padding: 10px; }
  section { background: #1c1f26; border: 1px solid #2c303a; border-radius: 8px; padding: 10px; min-width: 0; }
  section h2 { font-size: 13px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .06em; color: #9fb0c3; }
  button { background: #2b6cb0; color: #fff; border: 0; border-radius: 5px; padding: 5px 10px; cursor: pointer; font-size: 13px; }
  button.secondary { background: #3a4152; }
  button.danger { background: #8b3030; }
  button:disabled { opacity: .45; cursor: default; }
  input, select, textarea { background: #12141a; color: #e8eaed; border: 1px solid #3a4152; border-radius: 5px; padding: 4px 6px; font-size: 13px; width: 100%; }
  input[type=checkbox] { width: auto; }
  label { font-size: 12px; color: #9fb0c3; display: block; margin: 6px 0 2px; }
  .row { display: flex; gap: 6px; align-items: center; }
  .row > * { flex: 1; }
  .asset, .cue, .job, .histItem { border: 1px solid #2c303a; border-radius: 6px; padding: 6px; margin: 6px 0; font-size: 12px; }
  .asset b, .cue b { color: #fff; }
  #previewWrap { position: relative; background: #000; border-radius: 6px; min-height: 220px; display: flex; align-items: center; justify-content: center; }
  #previewImg { max-width: 100%; max-height: 46vh; display: block; }
  #previewBusy { position: absolute; inset: auto 8px 8px auto; background: rgba(0,0,0,.7); padding: 3px 8px; border-radius: 4px; font-size: 12px; display: none; }
  #transport { display: flex; gap: 6px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
  #timeLabel { font-variant-numeric: tabular-nums; font-size: 13px; min-width: 110px; }
  #timeline { overflow-x: auto; border: 1px solid #2c303a; border-radius: 6px; margin-top: 10px; background: #12141a; }
  #ruler { height: 18px; position: relative; border-bottom: 1px solid #2c303a; cursor: pointer; }
  .track { position: relative; height: 44px; border-bottom: 1px solid #232833; }
  .trackHead { position: sticky; left: 0; z-index: 3; background: #1c1f26; width: 150px; height: 100%; float: left; padding: 3px 6px; font-size: 11px; border-right: 1px solid #2c303a; }
  .trackLane { position: relative; height: 100%; margin-left: 150px; }
  .clip { position: absolute; top: 5px; height: 34px; background: #2b6cb0; border: 1px solid #63a4d8; border-radius: 4px; font-size: 11px; padding: 2px 4px; overflow: hidden; cursor: pointer; white-space: nowrap; }
  .clip.audio { background: #276749; border-color: #48bb78; }
  .clip.selected { outline: 2px solid #f6e05e; }
  #playhead { position: absolute; top: 0; bottom: 0; width: 2px; background: #f56565; z-index: 4; pointer-events: none; }
  #waveCanvas { width: 100%; height: 64px; background: #12141a; border-radius: 4px; }
  progress { width: 100%; height: 14px; }
  .small { font-size: 11px; color: #9fb0c3; }
  ul.tight { margin: 4px 0; padding-left: 16px; font-size: 12px; }
  @media (max-width: 980px) {
    main { grid-template-columns: 1fr; }
    #previewImg { max-height: 34vh; }
  }
</style>
</head>
<body>
<header>
  <h1>ClipForge Web Editor</h1>
  <span id="projName">…</span>
  <span class="spacer"></span>
  <span id="saveState" class="small">Not saved yet</span>
  <button id="saveBtn" class="secondary">Save (Ctrl+S)</button>
  <button id="newBtn" class="secondary">New project</button>
</header>
<div id="errorBar"></div>
<div id="recoverBar" style="display:none;background:#3a341f;color:#ffe9a8;padding:8px 14px;font-size:13px"></div>
<main>
  <section id="mediaPanel">
    <h2>Media library</h2>
    <input type="file" id="fileInput" accept="video/*,audio/*,image/*">
    <div class="row" style="margin-top:6px">
      <input id="probePath" placeholder="…or a file already in the media folder">
      <button id="probeBtn" class="secondary">Probe</button>
    </div>
    <label>Add clips to track</label>
    <select id="targetTrack"></select>
    <div id="assetList"></div>
    <h2 style="margin-top:14px">Analysis</h2>
    <canvas id="waveCanvas" width="520" height="64"></canvas>
    <div id="analysisOut" class="small">Select an asset, then Waveform or Analyze.</div>
  </section>

  <section id="stagePanel">
    <h2>Preview (real rendered frames)</h2>
    <div id="previewWrap"><img id="previewImg" alt="preview frame"><div id="previewBusy">Rendering frame…</div></div>
    <div id="transport">
      <button id="playBtn">Play</button>
      <button id="stopBtn" class="secondary">Stop</button>
      <button id="prevFrameBtn" class="secondary">|&lt;</button>
      <button id="nextFrameBtn" class="secondary">&gt;|</button>
      <span id="timeLabel">0.000s / 0.000s</span>
      <select id="speedSel" style="max-width:90px">
        <option value="0.25">0.25×</option><option value="0.5">0.5×</option>
        <option value="1" selected>1×</option><option value="1.5">1.5×</option>
        <option value="2">2×</option><option value="4">4×</option>
      </select>
      <label style="margin:0">Zoom</label>
      <input id="zoomRange" type="range" min="4" max="200" value="40" style="max-width:130px">
    </div>
    <div id="timeline">
      <div id="ruler"></div>
      <div id="tracksBox" style="position:relative"></div>
    </div>
    <p class="small">Shortcuts: Space play/pause · ←/→ step frame (Shift = 1s) · Home stop · S split at playhead · Delete remove clip · Ctrl+S save. Preview playback steps through frames the server actually renders — rate depends on project size.</p>
    <h2>Text overlays</h2>
    <div class="row"><input id="textVal" placeholder="Text"><input id="textStart" type="number" step="0.1" value="0" title="start s"><input id="textDur" type="number" step="0.1" value="2" title="duration s"><button id="addTextBtn">Add</button></div>
    <div id="textList"></div>
  </section>

  <section id="propsPanel">
    <h2>Properties</h2>
    <div id="noSel" class="small">Select a clip on the timeline.</div>
    <div id="clipProps" style="display:none">
      <div class="small" id="clipInfo"></div>
      <label>Timeline start (s)</label>
      <input id="pStart" type="number" step="0.1" min="0">
      <label>Position X / Y</label>
      <div class="row"><input id="pX" type="number"><input id="pY" type="number"></div>
      <label>Scale / Rotation° / Opacity</label>
      <div class="row"><input id="pScale" type="number" step="0.05"><input id="pRot" type="number" step="1"><input id="pOpacity" type="number" step="0.05" min="0" max="1"></div>
      <label>Speed / Volume</label>
      <div class="row"><input id="pSpeed" type="number" step="0.25" min="0.25" max="4"><input id="pVol" type="number" step="0.1" min="0" max="2"></div>
      <label>Fade in / out (s)</label>
      <div class="row"><input id="pFadeIn" type="number" step="0.1" min="0"><input id="pFadeOut" type="number" step="0.1" min="0"></div>
      <div class="row" style="margin-top:8px">
        <button id="applyPropsBtn">Apply</button>
        <button id="splitBtn" class="secondary">Split at playhead</button>
      </div>
      <div class="row" style="margin-top:6px">
        <button id="dupBtn" class="secondary">Duplicate</button>
        <button id="delClipBtn" class="danger">Delete clip</button>
      </div>
      <label>Effect</label>
      <div class="row">
        <select id="fxType"><option>brightness</option><option>contrast</option><option>saturation</option><option>temperature</option><option>blur</option><option>sharpen</option></select>
        <input id="fxVal" type="number" step="0.1" value="0.3">
        <button id="addFxBtn">Add</button>
      </div>
      <div id="fxList"></div>
      <label>Transition after this clip</label>
      <div class="row">
        <select id="trType"><option>crossfade</option><option>fade-black</option><option>fade-white</option><option>wipe-left</option><option>wipe-right</option><option>slide-left</option><option>slide-right</option><option>zoom-in</option></select>
        <input id="trDur" type="number" step="0.1" value="0.5" min="0.1">
        <button id="addTrBtn">Add</button>
      </div>
    </div>
    <h2 style="margin-top:14px">Tracks</h2>
    <div class="row"><button id="addVideoTrackBtn" class="secondary">+ Video track</button><button id="addAudioTrackBtn" class="secondary">+ Audio track</button></div>
    <div id="trackList"></div>
    <h2 style="margin-top:14px">Captions</h2>
    <div class="row"><input id="capStart" type="number" step="0.1" value="0"><input id="capEnd" type="number" step="0.1" value="2"></div>
    <div class="row" style="margin-top:4px"><input id="capText" placeholder="Caption text"><button id="addCapBtn">Add</button></div>
    <div id="capList"></div>
    <div class="row" style="margin-top:6px">
      <button id="capExportBtn" class="secondary">Export SRT</button>
      <button id="capImportBtn" class="secondary">Import SRT</button>
    </div>
    <textarea id="capIo" rows="4" placeholder="SRT content appears / is read here"></textarea>
    <h2 style="margin-top:14px">Export</h2>
    <label>Preset</label><select id="presetSel"></select>
    <label>Encoder</label>
    <select id="encoderSel"><option value="software">Software (libx264)</option><option value="auto">Auto (verified hardware, else software)</option></select>
    <div id="encoderNote" class="small"></div>
    <div class="row" style="margin-top:8px">
      <button id="exportNowBtn">Export now</button>
      <button id="queueJobBtn" class="secondary">Queue render job</button>
    </div>
    <div id="jobBox"></div>
    <label>History</label>
    <div id="historyList"></div>
  </section>
</main>
<div id="statusLine" style="padding:0 14px 12px">Loading…</div>

<script>
'use strict';
var BASE = location.pathname.replace(/\/app\/?$/, '');
var state = {
  project: null,        // serialized project {format, version, project, media}
  selectedClipId: null,
  selectedAssetPath: null,
  playhead: 0,
  playing: false,
  playTimer: null,
  frameBusy: false,
  pxPerSec: 40,
  hidden: {},
  saveTimer: null,
  jobPoll: null
};
function $(id) { return document.getElementById(id); }
function showError(msg) { var b = $('errorBar'); b.textContent = msg; b.style.display = msg ? 'block' : 'none'; }
function setStatus(msg) { $('statusLine').textContent = msg; }
function api(path, body, method) {
  var opts = { method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(BASE + path, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok || j.success === false) throw new Error(j.error || ('Request failed: ' + r.status));
      return j;
    });
  });
}
function proj() { return state.project.project; }
function duration() {
  var d = 0;
  proj().tracks.forEach(function (t) { t.clips.forEach(function (c) { var e = c.trackStart + (c.sourceOut - c.sourceIn) / (c.speed || 1); if (e > d) d = e; }); });
  (proj().texts || []).forEach(function (t) { var e = t.trackStart + t.durationSec; if (e > d) d = e; });
  return d;
}
function findClip(clipId) {
  var found = null;
  proj().tracks.forEach(function (t) { t.clips.forEach(function (c) { if (c.id === clipId) found = { clip: c, track: t }; }); });
  return found;
}
function mediaById(id) { var m = null; state.project.media.forEach(function (a) { if (a.id === id) m = a; }); return m; }
function clipLabel(c) { var a = mediaById(c.mediaId); return (a ? a.path.split(/[\\/]/).pop() : c.mediaId) + ' ' + ((c.sourceOut - c.sourceIn) / (c.speed || 1)).toFixed(1) + 's'; }

function scheduleSave() {
  $('saveState').textContent = 'Unsaved changes';
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 900);
}
function saveNow() {
  if (!state.project) return Promise.resolve();
  return api('/project/save', { project: state.project }).then(function (j) {
    $('saveState').textContent = 'Autosaved ' + new Date(j.savedAt).toLocaleTimeString();
  }).catch(function (e) { $('saveState').textContent = 'Save failed: ' + e.message; });
}
function applyOp(op) {
  return api('/operations', { project: state.project, operation: op }).then(function (j) {
    state.project = j.project;
    renderAll();
    scheduleSave();
    return j;
  }).catch(function (e) { showError(e.message); throw e; });
}

/* ---------- timeline rendering ---------- */
function renderTimeline() {
  var box = $('tracksBox'); box.innerHTML = '';
  var totalW = Math.max(duration(), 10) * state.pxPerSec + 170;
  var ruler = $('ruler'); ruler.style.width = totalW + 'px'; ruler.innerHTML = '';
  for (var s = 0; s <= Math.max(duration(), 10); s++) {
    var tick = document.createElement('span');
    tick.textContent = s + 's';
    tick.style.cssText = 'position:absolute;top:2px;font-size:10px;color:#9fb0c3;left:' + (150 + s * state.pxPerSec) + 'px';
    ruler.appendChild(tick);
  }
  var ph = document.createElement('div'); ph.id = 'playhead';
  ph.style.left = (150 + state.playhead * state.pxPerSec) + 'px';
  box.appendChild(ph);
  proj().tracks.forEach(function (t) {
    var row = document.createElement('div'); row.className = 'track'; row.style.width = totalW + 'px';
    var head = document.createElement('div'); head.className = 'trackHead';
    head.textContent = t.name + ' (' + t.kind + ')';
    var eye = document.createElement('button'); eye.className = 'secondary'; eye.textContent = state.hidden[t.id] ? 'Show' : 'Hide';
    eye.style.cssText = 'padding:1px 6px;font-size:11px;margin-left:4px';
    eye.onclick = function () { state.hidden[t.id] = !state.hidden[t.id]; renderTimeline(); requestFrame(state.playhead); };
    head.appendChild(eye);
    row.appendChild(head);
    var lane = document.createElement('div'); lane.className = 'trackLane';
    t.clips.forEach(function (c) {
      var el = document.createElement('div');
      el.className = 'clip' + (t.kind === 'audio' ? ' audio' : '') + (c.id === state.selectedClipId ? ' selected' : '');
      el.style.left = (c.trackStart * state.pxPerSec) + 'px';
      el.style.width = Math.max(14, ((c.sourceOut - c.sourceIn) / (c.speed || 1)) * state.pxPerSec - 2) + 'px';
      el.textContent = clipLabel(c);
      el.title = clipLabel(c);
      el.onclick = function () { state.selectedClipId = c.id; seek(c.trackStart); renderAll(); };
      lane.appendChild(el);
    });
    row.appendChild(lane);
    box.appendChild(row);
  });
  $('timeLabel').textContent = state.playhead.toFixed(3) + 's / ' + duration().toFixed(3) + 's';
}
function renderTracksPanel() {
  var sel = $('targetTrack'); var cur = sel.value; sel.innerHTML = '';
  proj().tracks.forEach(function (t) { var o = document.createElement('option'); o.value = t.id; o.textContent = t.name + ' (' + t.kind + ')'; sel.appendChild(o); });
  if (cur) sel.value = cur;
  var list = $('trackList'); list.innerHTML = '';
  proj().tracks.forEach(function (t) {
    var div = document.createElement('div'); div.className = 'asset';
    div.innerHTML = '<b></b>';
    div.querySelector('b').textContent = t.name + ' (' + t.kind + ')';
    var vol = document.createElement('input'); vol.type = 'range'; vol.min = '0'; vol.max = '2'; vol.step = '0.05'; vol.value = String(t.volume == null ? 1 : t.volume);
    vol.title = 'Track volume';
    vol.onchange = function () { applyOp({ type: 'setTrackVolume', trackId: t.id, volume: Number(vol.value) }); };
    var mute = document.createElement('label'); mute.style.display = 'inline';
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!t.muted;
    cb.onchange = function () { applyOp({ type: 'setTrackMuted', trackId: t.id, muted: cb.checked }); };
    mute.appendChild(cb); mute.appendChild(document.createTextNode(' Muted'));
    div.appendChild(vol); div.appendChild(mute);
    list.appendChild(div);
  });
}
function renderAssets() {
  var list = $('assetList'); list.innerHTML = '';
  state.project.media.forEach(function (a) {
    var div = document.createElement('div'); div.className = 'asset';
    var name = a.path.split(/[\\/]/).pop();
    div.innerHTML = '<b></b><br><span class="small"></span>';
    div.querySelector('b').textContent = name;
    div.querySelector('.small').textContent = (a.kind || 'media') + ' · ' + (a.hasVideo ? a.width + 'x' + a.height + ' ' : '') + (a.durationSec ? a.durationSec.toFixed(2) + 's' : 'still');
    var row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '4px';
    var add = document.createElement('button'); add.textContent = 'Add clip';
    add.onclick = function () {
      var trackId = $('targetTrack').value;
      if (!trackId) { showError('No target track — add a track first.'); return; }
      var out = a.kind === 'image' || !a.durationSec ? 3 : a.durationSec;
      applyOp({ type: 'addClip', trackId: trackId, clip: { mediaId: a.id, trackStart: state.playhead, sourceIn: 0, sourceOut: out } });
    };
    var wf = document.createElement('button'); wf.className = 'secondary'; wf.textContent = 'Waveform';
    wf.onclick = function () { state.selectedAssetPath = a.path; drawWaveform(a); };
    var an = document.createElement('button'); an.className = 'secondary'; an.textContent = 'Analyze';
    an.onclick = function () { state.selectedAssetPath = a.path; runAnalyze(a); };
    row.appendChild(add); row.appendChild(wf); row.appendChild(an);
    div.appendChild(row);
    list.appendChild(div);
  });
}
function renderProps() {
  var sel = state.selectedClipId ? findClip(state.selectedClipId) : null;
  $('noSel').style.display = sel ? 'none' : 'block';
  $('clipProps').style.display = sel ? 'block' : 'none';
  if (!sel) return;
  var c = sel.clip; var t = c.transform || { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1 };
  $('clipInfo').textContent = clipLabel(c) + ' on ' + sel.track.name + ' · source ' + c.sourceIn.toFixed(2) + '–' + c.sourceOut.toFixed(2) + 's';
  $('pStart').value = c.trackStart;
  $('pX').value = t.x; $('pY').value = t.y; $('pScale').value = t.scale; $('pRot').value = t.rotationDeg; $('pOpacity').value = t.opacity;
  $('pSpeed').value = c.speed || 1; $('pVol').value = c.volume == null ? 1 : c.volume;
  $('pFadeIn').value = c.fadeInSec || 0; $('pFadeOut').value = c.fadeOutSec || 0;
  var fx = $('fxList'); fx.innerHTML = '';
  (c.effects || []).forEach(function (e) {
    var div = document.createElement('div'); div.className = 'asset';
    div.textContent = e.type + ' = ' + e.value + ' ';
    var rm = document.createElement('button'); rm.className = 'danger'; rm.textContent = 'Remove';
    rm.onclick = function () { applyOp({ type: 'removeEffect', clipId: c.id, effectId: e.id }); };
    div.appendChild(rm); fx.appendChild(div);
  });
}
function renderTexts() {
  var list = $('textList'); list.innerHTML = '';
  (proj().texts || []).forEach(function (t) {
    var div = document.createElement('div'); div.className = 'cue';
    div.textContent = '"' + t.text + '" · ' + t.trackStart.toFixed(1) + 's +' + t.durationSec.toFixed(1) + 's ';
    var rm = document.createElement('button'); rm.className = 'danger'; rm.textContent = 'Remove';
    rm.onclick = function () { applyOp({ type: 'removeText', textId: t.id }); };
    div.appendChild(rm); list.appendChild(div);
  });
}
function renderCaptions() {
  var list = $('capList'); list.innerHTML = '';
  (proj().captions || []).forEach(function (c) {
    var div = document.createElement('div'); div.className = 'cue';
    div.textContent = c.startSec.toFixed(2) + '–' + c.endSec.toFixed(2) + 's · ' + c.text + ' ';
    var rm = document.createElement('button'); rm.className = 'danger'; rm.textContent = 'Remove';
    rm.onclick = function () { applyOp({ type: 'removeCaption', cueId: c.id }); };
    div.appendChild(rm); list.appendChild(div);
  });
}
function renderAll() { renderTimeline(); renderTracksPanel(); renderAssets(); renderProps(); renderTexts(); renderCaptions(); $('projName').textContent = proj().name + ' · ' + proj().width + 'x' + proj().height + ' @' + proj().fps; }

/* ---------- preview & transport ---------- */
function requestFrame(t) {
  if (!state.project || state.frameBusy) return Promise.resolve();
  state.frameBusy = true; $('previewBusy').style.display = 'block';
  var hidden = Object.keys(state.hidden).filter(function (k) { return state.hidden[k]; });
  return api('/preview/frame', { project: state.project, timeSec: t, hiddenTrackIds: hidden }).then(function (j) {
    $('previewImg').src = j.frame.imageUrl;
    showError('');
  }).catch(function (e) { showError('Preview: ' + e.message); }).then(function () {
    state.frameBusy = false; $('previewBusy').style.display = 'none';
  });
}
function seek(t) {
  state.playhead = Math.max(0, Math.min(t, duration()));
  renderTimeline();
  return requestFrame(state.playhead);
}
function stopPlay() {
  state.playing = false; clearInterval(state.playTimer); state.playTimer = null;
  $('playBtn').textContent = 'Play';
}
function togglePlay() {
  if (state.playing) { stopPlay(); return; }
  if (state.playhead >= duration() - 0.001) state.playhead = 0;
  state.playing = true; $('playBtn').textContent = 'Pause';
  var speed = Number($('speedSel').value);
  state.playTimer = setInterval(function () {
    state.playhead += 0.12 * speed;
    if (state.playhead >= duration()) { state.playhead = duration(); stopPlay(); }
    renderTimeline();
    requestFrame(state.playhead);
  }, 120);
}

/* ---------- analysis ---------- */
function drawWaveform(asset) {
  var name = asset.path.split(/[\\/]/).pop();
  api('/waveform', { path: name, bucketsPerSecond: 20 }).then(function (j) {
    var cv = $('waveCanvas'); var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height); ctx.fillStyle = '#48bb78';
    var peaks = j.waveform.peaks; var w = cv.width / peaks.length;
    peaks.forEach(function (p, i) { var h = Math.max(1, p * cv.height); ctx.fillRect(i * w, (cv.height - h) / 2, Math.max(1, w - 0.5), h); });
    $('analysisOut').textContent = 'Waveform of ' + name + ' — ' + peaks.length + ' buckets from the real audio.';
  }).catch(function (e) { showError('Waveform: ' + e.message); });
}
function runAnalyze(asset) {
  var name = asset.path.split(/[\\/]/).pop();
  api('/analyze', { path: name }).then(function (j) {
    var a = j.analysis;
    var lines = ['Scenes at: ' + (a.sceneChangesSec.map(function (x) { return x.toFixed(2) + 's'; }).join(', ') || 'none'),
      'Silences: ' + (a.silences.map(function (s) { return s.startSec.toFixed(2) + '–' + s.endSec.toFixed(2) + 's'; }).join(', ') || 'none'),
      'Suggested cuts: ' + a.suggestedCuts.length];
    $('analysisOut').textContent = lines.join(' · ');
  }).catch(function (e) { showError('Analyze: ' + e.message); });
}

/* ---------- export ---------- */
function exportSettings() {
  return { preset: $('presetSel').value, settings: { encoderPreference: $('encoderSel').value } };
}
function renderHistory() {
  api('/export/history').then(function (j) {
    var list = $('historyList'); list.innerHTML = '';
    if (!j.history.length) { list.innerHTML = '<div class="small">No exports yet.</div>'; return; }
    j.history.forEach(function (h) {
      var div = document.createElement('div'); div.className = 'histItem';
      div.textContent = h.status + ' · ' + (h.settings.preset || 'source') + ' · ' + new Date(h.createdAt).toLocaleString() + (h.outputBytes ? ' · ' + h.outputBytes + ' B' : '') + (h.error ? ' · ' + h.error : '');
      if (h.status === 'succeeded' && !h.outputDeleted) {
        var del = document.createElement('button'); del.className = 'danger'; del.textContent = 'Delete output';
        del.onclick = function () { api('/export/jobs/' + h.id + '/output', undefined, 'DELETE').then(renderHistory).catch(function (e) { showError(e.message); }); };
        div.appendChild(document.createTextNode(' ')); div.appendChild(del);
      }
      if (h.status === 'failed' || h.status === 'interrupted' || h.status === 'cancelled') {
        var rt = document.createElement('button'); rt.className = 'secondary'; rt.textContent = 'Retry';
        rt.onclick = function () { api('/export/jobs/' + h.id + '/retry', {}).then(function () { pollJob(h.id); }).catch(function (e) { showError(e.message); }); };
        div.appendChild(document.createTextNode(' ')); div.appendChild(rt);
      }
      list.appendChild(div);
    });
  }).catch(function () { /* history is best-effort UI */ });
}
function pollJob(jobId) {
  clearInterval(state.jobPoll);
  var box = $('jobBox');
  box.innerHTML = '<div class="small">Job ' + jobId.slice(0, 8) + '…</div><progress max="1" value="0"></progress><div class="small" id="jobState"></div>';
  var bar = box.querySelector('progress'); var label = box.querySelector('#jobState');
  var cancelBtn = document.createElement('button'); cancelBtn.className = 'danger'; cancelBtn.textContent = 'Cancel render';
  cancelBtn.onclick = function () { api('/export/jobs/' + jobId + '/cancel', {}).catch(function (e) { showError(e.message); }); };
  box.appendChild(cancelBtn);
  state.jobPoll = setInterval(function () {
    api('/export/jobs/' + jobId).then(function (j) {
      bar.value = j.job.progress || 0;
      label.textContent = j.job.status + ' · ' + Math.round((j.job.progress || 0) * 100) + '%' + (j.job.encoderUsed ? ' · ' + j.job.encoderUsed : '') + (j.job.error ? ' · ' + j.job.error : '');
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].indexOf(j.job.status) >= 0) {
        clearInterval(state.jobPoll); cancelBtn.remove(); renderHistory();
      }
    }).catch(function (e) { clearInterval(state.jobPoll); showError('Job poll: ' + e.message); });
  }, 1000);
}

/* ---------- wiring ---------- */
function bind() {
  $('saveBtn').onclick = saveNow;
  $('newBtn').onclick = function () {
    var name = prompt('Project name', 'Untitled project'); if (name === null) return;
    api('/project/create', { name: name, width: 1280, height: 720, fps: 30 }).then(function (j) {
      state.project = j.project; state.selectedClipId = null; state.playhead = 0;
      renderAll(); scheduleSave(); seek(0);
    }).catch(function (e) { showError(e.message); });
  };
  $('fileInput').onchange = function () {
    var f = $('fileInput').files[0]; if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var b64 = String(reader.result).split(',')[1];
      api('/media/import', { filename: f.name, dataBase64: b64 }).then(function (j) {
        state.project.media.push(j.asset); renderAssets(); scheduleSave();
        setStatus('Imported ' + f.name + ' (' + (j.asset.kind || 'media') + ')');
      }).catch(function (e) { showError('Import: ' + e.message); });
    };
    reader.readAsDataURL(f);
  };
  $('probeBtn').onclick = function () {
    var p = $('probePath').value.trim(); if (!p) return;
    api('/probe', { path: p }).then(function (j) {
      state.project.media.push(j.asset); renderAssets(); scheduleSave();
    }).catch(function (e) { showError('Probe: ' + e.message); });
  };
  $('playBtn').onclick = togglePlay;
  $('stopBtn').onclick = function () { stopPlay(); seek(0); };
  $('prevFrameBtn').onclick = function () { seek(state.playhead - 1 / proj().fps); };
  $('nextFrameBtn').onclick = function () { seek(state.playhead + 1 / proj().fps); };
  $('zoomRange').oninput = function () { state.pxPerSec = Number($('zoomRange').value); renderTimeline(); };
  $('ruler').onclick = function (ev) {
    var rect = $('ruler').getBoundingClientRect();
    seek(Math.max(0, (ev.clientX - rect.left - 150 + $('timeline').scrollLeft * 0) / state.pxPerSec));
  };
  $('applyPropsBtn').onclick = function () {
    var sel = findClip(state.selectedClipId); if (!sel) return;
    var c = sel.clip;
    var chain = Promise.resolve();
    if (Number($('pStart').value) !== c.trackStart) {
      chain = chain.then(function () { return applyOp({ type: 'move', clipId: c.id, trackStart: Number($('pStart').value) }); });
    }
    chain.then(function () { return applyOp({ type: 'setTransform', clipId: c.id, transform: { x: Number($('pX').value), y: Number($('pY').value), scale: Number($('pScale').value), rotationDeg: Number($('pRot').value), opacity: Number($('pOpacity').value) } }); })
      .then(function () { return applyOp({ type: 'setSpeed', clipId: c.id, speed: Number($('pSpeed').value) }); })
      .then(function () { return applyOp({ type: 'setVolume', clipId: c.id, volume: Number($('pVol').value) }); })
      .then(function () { return applyOp({ type: 'setFades', clipId: c.id, fadeInSec: Number($('pFadeIn').value), fadeOutSec: Number($('pFadeOut').value) }); })
      .catch(function () { /* error already shown */ });
  };
  $('splitBtn').onclick = function () { if (state.selectedClipId) applyOp({ type: 'split', clipId: state.selectedClipId, atTimelineSec: state.playhead }); };
  $('dupBtn').onclick = function () { if (state.selectedClipId) applyOp({ type: 'duplicate', clipId: state.selectedClipId }); };
  $('delClipBtn').onclick = function () { if (state.selectedClipId) { var id = state.selectedClipId; state.selectedClipId = null; applyOp({ type: 'remove', clipId: id }); } };
  $('addFxBtn').onclick = function () { if (state.selectedClipId) applyOp({ type: 'addEffect', clipId: state.selectedClipId, effectType: $('fxType').value, value: Number($('fxVal').value) }); };
  $('addTrBtn').onclick = function () { if (state.selectedClipId) applyOp({ type: 'addTransition', afterClipId: state.selectedClipId, durationSec: Number($('trDur').value), transitionType: $('trType').value }); };
  $('addVideoTrackBtn').onclick = function () { applyOp({ type: 'addTrack', kind: 'video' }); };
  $('addAudioTrackBtn').onclick = function () { applyOp({ type: 'addTrack', kind: 'audio' }); };
  $('addTextBtn').onclick = function () {
    applyOp({ type: 'addText', text: { text: $('textVal').value, trackStart: Number($('textStart').value), durationSec: Number($('textDur').value), x: 40, y: 40, fontSize: 36, color: '#FFFFFF' } });
  };
  $('addCapBtn').onclick = function () {
    applyOp({ type: 'addCaption', caption: { startSec: Number($('capStart').value), endSec: Number($('capEnd').value), text: $('capText').value } });
  };
  $('capExportBtn').onclick = function () {
    api('/captions/export', { project: state.project, format: 'srt' }).then(function (j) { $('capIo').value = j.content; }).catch(function (e) { showError(e.message); });
  };
  $('capImportBtn').onclick = function () {
    api('/captions/import', { project: state.project, format: 'srt', content: $('capIo').value }).then(function (j) {
      state.project = j.project; renderAll(); scheduleSave();
    }).catch(function (e) { showError('Caption import: ' + e.message); });
  };
  $('exportNowBtn').onclick = function () {
    var s = exportSettings(); $('exportNowBtn').disabled = true;
    api('/export', { project: state.project, preset: s.preset, settings: s.settings }).then(function (j) {
      setStatus('Exported: ' + j.result.outputPath + ' · ' + j.result.probe.width + 'x' + j.result.probe.height + ' · ' + j.result.durationSec.toFixed(2) + 's · encoder ' + (j.result.encoderUsed || 'libx264'));
      renderHistory();
    }).catch(function (e) { showError('Export: ' + e.message); }).then(function () { $('exportNowBtn').disabled = false; });
  };
  $('queueJobBtn').onclick = function () {
    var s = exportSettings();
    api('/export/jobs', { project: state.project, preset: s.preset, settings: s.settings }).then(function (j) { pollJob(j.job.id); }).catch(function (e) { showError('Queue job: ' + e.message); });
  };
  document.addEventListener('keydown', function (ev) {
    var tag = (ev.target && ev.target.tagName) || '';
    if (ev.ctrlKey && (ev.key === 's' || ev.key === 'S')) { ev.preventDefault(); saveNow(); return; }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (ev.code === 'Space') { ev.preventDefault(); togglePlay(); }
    else if (ev.key === 'ArrowLeft') seek(state.playhead - (ev.shiftKey ? 1 : 1 / proj().fps));
    else if (ev.key === 'ArrowRight') seek(state.playhead + (ev.shiftKey ? 1 : 1 / proj().fps));
    else if (ev.key === 'Home') { stopPlay(); seek(0); }
    else if ((ev.key === 's' || ev.key === 'S') && state.selectedClipId) applyOp({ type: 'split', clipId: state.selectedClipId, atTimelineSec: state.playhead });
    else if (ev.key === 'Delete' && state.selectedClipId) { var id = state.selectedClipId; state.selectedClipId = null; applyOp({ type: 'remove', clipId: id }); }
  });
}

/* ---------- boot ---------- */
function boot() {
  bind();
  api('/status').then(function (j) {
    setStatus(j.ffmpegFound ? 'ffmpeg ready' : 'ffmpeg NOT found — preview and export are unavailable on this host');
  }).catch(function (e) { setStatus('Status failed: ' + e.message); });
  api('/render/capabilities').then(function (j) {
    var sel = $('presetSel'); sel.innerHTML = '';
    j.capabilities.presets.forEach(function (p) { var o = document.createElement('option'); o.value = p.name; o.textContent = p.label + (p.width ? ' (' + p.width + 'x' + p.height + ')' : ''); sel.appendChild(o); });
    sel.value = '720p';
    $('encoderNote').textContent = j.capabilities.notes.join(' ');
  }).catch(function () { /* capabilities are informational */ });
  api('/project/load').then(function (j) {
    state.project = j.project;
    var bar = $('recoverBar');
    bar.style.display = 'block';
    bar.textContent = 'Recovered your saved project (journal state: ' + (j.journalState || 'unknown') + '). Autosave keeps it current as you edit.';
    renderAll(); seek(0); renderHistory();
  }).catch(function () {
    api('/project/create', { name: 'Untitled project', width: 1280, height: 720, fps: 30 }).then(function (j) {
      state.project = j.project; renderAll(); renderHistory();
    }).catch(function (e) { showError('Could not create a project: ' + e.message); });
  });
}
document.addEventListener('DOMContentLoaded', boot);
</script>
</body>
</html>
`;
