// Podcast AI Director v0.8.5
// WebGPU + VAD Fast Transcription, Low-Memory WebAudio Mixing, Multi-BGM, Intro/Outro Solo Boost, MP4 Telop

const $ = (id) => document.getElementById(id);

let source = null;
let segments = [];
let externalTelopSegments = null;
let ff = null;
let ffLoadPromise = null;
let ffLogs = [];
let validated = null;
let bgmTracks = []; // [{ id, file, name, duration }]
let se = null;
let seDuration = null;
let thumbnail = null;
let thumbnailUrl = null;
let sourceDuration = null;
let outputUrl = null;
let sourceUrl = null;
let activeWorker = null;
let elapsedTimer = null;

let ffProgressReporter = editProgress;
let ffProgressRange = {
  start: 65,
  span: 30,
  label: "エンコード中…"
};

function formatError(err) {
  if (!err) return "不明なエラーが発生しました。";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  if (err.error?.message) return err.error.message;
  if (err.type === "error") return "編集エンジンワーカーの読み込みに失敗しました。ページを再読み込みしてお試しください。";
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function getDeviceProfile(durationSec = 0) {
  const rawMem = Number(navigator.deviceMemory);
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || "");
  const isLowMem = Number.isFinite(rawMem) && rawMem <= 4;
  const isLongAudio = Number.isFinite(durationSec) && durationSec >= 1800; // 30分以上は自動省メモリ化
  if (isMobile || isLowMem || isLongAudio) {
    return {
      label: isLongAudio && !isMobile && !isLowMem ? "長尺省メモリモード" : "省メモリモード",
      sampleRate: 24000,
      videoWidth: 854,
      videoHeight: 480,
      crf: "25"
    };
  }
  return {
    label: "標準軽量モード",
    sampleRate: 32000,
    videoWidth: 1280,
    videoHeight: 720,
    crf: "23"
  };
}

const fmt = (s) => {
  const safe = Math.max(0, Number(s) || 0);
  const m = Math.floor(safe / 60);
  const x = (safe % 60).toFixed(1).padStart(4, "0");
  return `${String(m).padStart(2, "0")}:${x}`;
};

function setActiveStep(stepNum) {
  document.querySelectorAll(".steps span").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.step) <= stepNum);
  });
}

function progress(p, t, d = "") {
  const safe = Math.min(100, Math.max(0, Number(p) || 0));
  $("progressbox").hidden = false;
  $("progress").value = safe;
  $("progressNum").textContent = safe > 0 && safe < 100 ? `${safe.toFixed(1)}%` : `${Math.round(safe)}%`;
  $("progressText").textContent = t;
  $("progressDetail").textContent = d;
}

function editProgress(p, t, d = "") {
  $("editProgressBox").hidden = false;
  $("editProgress").value = p;
  $("editProgressNum").textContent = `${p}%`;
  $("editProgressText").textContent = t;
  if ($("editProgressDetail")) $("editProgressDetail").textContent = d;
}

function startElapsedTimer() {
  stopElapsedTimer();
  const startedAt = Date.now();
  const update = () => {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    $("progressTimer").textContent = m > 0 ? `経過時間: ${m}分${s}秒` : `経過時間: ${s}秒`;
  };
  update();
  elapsedTimer = setInterval(update, 1000);
}

function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function bindFileInput(el, onFile) {
  if (!el) return;
  el.addEventListener("click", () => {
    el.value = "";
  });
  el.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
  });
}

function bindMultiFileInput(el, onFiles) {
  if (!el) return;
  el.addEventListener("click", () => {
    el.value = "";
  });
  el.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) onFiles(files);
  });
}

bindFileInput($("audio"), (file) => setAudio(file));

function updateSkipTranscribeState() {
  const hasInstructions = Boolean(validated || $("instructions").value.trim());
  const banner = $("skipTranscribeBanner");
  const hint = $("skipTranscribeHint");
  const btn = $("transcribe");

  if (hasInstructions) {
    banner.classList.add("ready");
    hint.textContent = source
      ? "✓ 編集指示JSONが準備済みのため、文字起こしはスキップしてそのまま STEP 04 で編集を実行できます。"
      : "✓ 編集指示JSONが準備済みです。上の枠から音源ファイルを選択すると、文字起こしなしでそのまま編集を実行できます。";
    btn.textContent = "タイムスタンプ付き文字起こしを作成（任意・JSON読込済み）";
  } else {
    banner.classList.remove("ready");
    hint.textContent = "すでに編集指示JSONをお持ちの場合は、文字起こしを実行せず下の STEP 03 から直接読み込めます。";
    btn.textContent = "タイムスタンプ付き文字起こしを作成";
  }
  updateExecuteButtonState();
}

function updateExecuteButtonState() {
  const execBtn = $("execute");
  if (!execBtn) return;
  if (!source) {
    execBtn.disabled = true;
    execBtn.textContent = "STEP 01 で収録音源を選択すると編集を実行できます";
  } else {
    const profile = getDeviceProfile(sourceDuration || 0);
    execBtn.disabled = false;
    execBtn.textContent = `編集を実行（${profile.label}）`;
  }
}

function setAudio(f) {
  if (!f) return;
  source = f;
  sourceDuration = null;
  $("audioName").textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} MB`;
  $("transcribe").disabled = false;
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = URL.createObjectURL(f);
  const audio = new Audio(sourceUrl);
  audio.onloadedmetadata = () => {
    sourceDuration = audio.duration;
    $("sourceDuration").textContent = `音源の長さ：${fmt(sourceDuration)}`;
    updateExecuteButtonState();
    if ($("instructions").value.trim()) {
      const ok = validate();
      if (ok) {
        $("editCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  };
  $("originalPreview").src = sourceUrl;
  $("compareCard").hidden = false;
  $("transcriptCard").hidden = false;
  $("jsonHeading").classList.toggle("subheading", !$("transcriptArea").hidden);
  $("output").hidden = true;
  if ($("instructions").value.trim()) {
    validate();
  } else {
    setActiveStep(1);
  }
  updateSkipTranscribeState();
}

const dropEl = $("drop");
dropEl.ondragover = (e) => {
  e.preventDefault();
  dropEl.classList.add("dragover");
};
dropEl.ondragleave = () => dropEl.classList.remove("dragover");
dropEl.ondrop = (e) => {
  e.preventDefault();
  dropEl.classList.remove("dragover");
  setAudio(e.dataTransfer.files[0]);
};

// --- Multi-BGM Playlist Management ---
async function addBgmFiles(files, replace = false) {
  const entries = [];
  for (const file of files) {
    let dur = null;
    try {
      dur = await getDuration(file);
    } catch {
      dur = null;
    }
    entries.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      file,
      name: file.name,
      duration: Number.isFinite(dur) && dur > 0 ? dur : null
    });
  }
  bgmTracks = replace ? entries : [...bgmTracks, ...entries];
  renderBgmPlaylist();
  if (validated) validate();
}

function renderBgmPlaylist() {
  const nameEl = $("bgmName");
  const listEl = $("bgmPlaylist");
  const clearBtn = $("bgmClear");
  const multiOpts = $("multiBgmOptions");

  if (!bgmTracks.length) {
    nameEl.textContent = "BGM未選択";
    listEl.hidden = true;
    listEl.innerHTML = "";
    clearBtn.hidden = true;
    multiOpts.hidden = true;
    return;
  }

  clearBtn.hidden = false;
  multiOpts.hidden = bgmTracks.length < 2;
  nameEl.textContent = bgmTracks.length === 1
    ? `選択中：${bgmTracks[0].name}${bgmTracks[0].duration ? `（${fmt(bgmTracks[0].duration)}）` : ""}`
    : `選択中：${bgmTracks.length}曲のBGMプレイリスト`;

  listEl.hidden = false;
  listEl.innerHTML = "";
  bgmTracks.forEach((tr, idx) => {
    const row = document.createElement("div");
    row.className = "playlist-item";

    const info = document.createElement("div");
    info.className = "playlist-item-info";
    const badge = document.createElement("span");
    badge.className = "playlist-badge";
    badge.textContent = String(idx + 1);
    const title = document.createElement("span");
    title.className = "playlist-title";
    title.textContent = tr.name;
    title.title = tr.name;
    const dur = document.createElement("span");
    dur.className = "playlist-dur";
    dur.textContent = tr.duration ? fmt(tr.duration) : "--:--";
    info.append(badge, title, dur);

    const actions = document.createElement("div");
    actions.className = "playlist-actions";

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "icon-btn";
    upBtn.textContent = "↑";
    upBtn.title = "上へ移動";
    upBtn.disabled = idx === 0;
    upBtn.onclick = () => {
      if (idx === 0) return;
      [bgmTracks[idx - 1], bgmTracks[idx]] = [bgmTracks[idx], bgmTracks[idx - 1]];
      renderBgmPlaylist();
      if (validated) validate();
    };

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "icon-btn";
    downBtn.textContent = "↓";
    downBtn.title = "下へ移動";
    downBtn.disabled = idx === bgmTracks.length - 1;
    downBtn.onclick = () => {
      if (idx >= bgmTracks.length - 1) return;
      [bgmTracks[idx + 1], bgmTracks[idx]] = [bgmTracks[idx], bgmTracks[idx + 1]];
      renderBgmPlaylist();
      if (validated) validate();
    };

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-btn";
    delBtn.textContent = "✕";
    delBtn.title = "削除";
    delBtn.onclick = () => {
      bgmTracks.splice(idx, 1);
      renderBgmPlaylist();
      if (validated) validate();
    };

    actions.append(upBtn, downBtn, delBtn);
    row.append(info, actions);
    listEl.append(row);
  });

  if (bgmTracks.length >= 2) {
    const note = document.createElement("div");
    note.className = "playlist-note";
    if ($("bgmAutoSwitch")?.checked) {
      const th = Math.max(5, Number($("bgmSwitchThreshold")?.value) || 20);
      const xf = Math.max(0, Number($("bgmCrossfadeSec")?.value) || 1.5);
      note.textContent = `✓ 自動切替ON：各曲の残り${th}秒以下になった後の最初の場面切り替えで次の曲へ（クロスフェード ${xf}秒）`;
    } else {
      note.textContent = "自動切替OFF：1曲目をループ再生します";
    }
    listEl.append(note);
  }
}

bindMultiFileInput($("bgm"), (files) => addBgmFiles(files, true));
bindMultiFileInput($("bgmAdd"), (files) => addBgmFiles(files, false));
$("bgmClear").onclick = () => {
  bgmTracks = [];
  renderBgmPlaylist();
  if (validated) validate();
};

["introBgmSec", "outroBgmSec", "boostBgmOnSolo", "bgmAutoSwitch", "bgmSwitchThreshold", "bgmCrossfadeSec"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("change", () => {
    renderBgmPlaylist();
    if (validated) validate();
  });
});

bindFileInput($("se"), async (file) => {
  se = file;
  seDuration = null;
  $("seName").textContent = `選択中：${se.name}`;
  try {
    seDuration = await getDuration(se);
    $("seName").textContent = `選択中：${se.name}（${seDuration.toFixed(1)}秒）`;
  } catch {
    // Keep base filename display
  }
  if (validated) validate();
});

$("seOnMarker").onchange = () => {
  if (validated) validate();
};

$("seMode").onchange = () => {
  if (validated) validate();
};

function updateFormatUi() {
  const isMp4 = $("format").value === "mp4";
  $("thumbnailField").classList.toggle("field-active", isMp4);
  if (!thumbnail) {
    $("thumbnailName").textContent = isMp4
      ? "サムネイル未選択（未指定の場合は単色背景でMP4出力します）"
      : "サムネイル未選択（MP4出力時に使用）";
  }
}

$("format").onchange = () => {
  updateFormatUi();
  if (validated) validate();
};

bindFileInput($("thumbnail"), (file) => {
  thumbnail = file;
  if (thumbnailUrl) {
    URL.revokeObjectURL(thumbnailUrl);
    thumbnailUrl = null;
  }
  thumbnailUrl = URL.createObjectURL(thumbnail);
  $("thumbnailPreview").src = thumbnailUrl;
  $("thumbnailPreviewWrap").hidden = false;
  $("thumbnailName").textContent = `選択中：${thumbnail.name}`;
  if ($("format").value !== "mp4") {
    $("format").value = "mp4";
  }
  updateFormatUi();
  if (validated) validate();
});

// --- Telop / Subtitle Management ---
function getActiveTelopSegments() {
  if (Array.isArray(externalTelopSegments) && externalTelopSegments.length > 0) {
    return externalTelopSegments;
  }
  if (Array.isArray(segments) && segments.length > 0) {
    return segments;
  }
  return [];
}

function updateTelopStatus() {
  const statusEl = $("telopStatus");
  if (!statusEl) return;
  const activeSegs = getActiveTelopSegments();
  if (activeSegs.length > 0) {
    const srcLabel = externalTelopSegments?.length ? "読込ファイル" : "STEP 01文字起こし";
    statusEl.className = "ok";
    statusEl.textContent = `✓ ${srcLabel}の字幕データ（${activeSegs.length}件）を使用します`;
  } else {
    statusEl.className = "";
    statusEl.textContent = "字幕データ未読込：STEP 01で文字起こしを実行するか、上のボタンからJSON/TXT/SRTを読み込んでください";
  }
}

function parseTimeToken(tok) {
  const clean = String(tok || "").trim().replace(",", ".");
  const parts = clean.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return NaN;
}

function parseTelopText(rawText) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) throw new Error("字幕ファイルが空です。");

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : parsed?.segments;
    if (!Array.isArray(list)) throw new Error("JSON内に segments 配列が見つかりません。");
    const out = list
      .map((item) => ({
        start: Number(item.start),
        end: Number(item.end),
        text: String(item.text || "").trim()
      }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text);
    if (!out.length) throw new Error("有効なタイムスタンプ付き字幕が見つかりません。");
    return out;
  }

  if (trimmed.includes("-->")) {
    const blocks = trimmed.split(/\r?\n\r?\n+/);
    const out = [];
    for (const blk of blocks) {
      const lines = blk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const timeLineIdx = lines.findIndex((l) => l.includes("-->"));
      if (timeLineIdx === -1) continue;
      const [lhs, rhs] = lines[timeLineIdx].split("-->");
      const start = parseTimeToken(lhs);
      const end = parseTimeToken((rhs || "").trim().split(/\s+/)[0]);
      const text = lines.slice(timeLineIdx + 1).join(" ").trim();
      if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) {
        out.push({ start, end, text });
      }
    }
    if (!out.length) throw new Error("SRTファイルから有効な字幕を抽出できませんでした。");
    return out;
  }

  const out = [];
  const lineRe = /^\[([0-9:.]+)\s*[-–—]\s*([0-9:.]+)\]\s*(.+)$/;
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const m = rawLine.trim().match(lineRe);
    if (!m) continue;
    const start = parseTimeToken(m[1]);
    const end = parseTimeToken(m[2]);
    const text = m[3].trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) {
      out.push({ start, end, text });
    }
  }
  if (!out.length) {
    throw new Error("対応形式（transcript.json / [00:00.0 - 00:05.0] 形式のTXT / SRT）として読み取れませんでした。");
  }
  return out;
}

$("enableTelop").onchange = () => {
  const enabled = $("enableTelop").checked;
  $("telopOptions").hidden = !enabled;
  if (enabled && $("format").value !== "mp4") {
    $("format").value = "mp4";
    updateFormatUi();
  }
  updateTelopStatus();
  if (validated) validate();
};

bindFileInput($("telopFile"), async (file) => {
  try {
    const text = await file.text();
    externalTelopSegments = parseTelopText(text);
    updateTelopStatus();
    if (validated) validate();
  } catch (err) {
    alert("字幕ファイルの読み込みに失敗しました: " + formatError(err));
  }
});

async function decodeAudioWithFFmpegFallback(file, channels, targetSampleRate, reporter = editProgress, basePct = 3, spanPct = 2) {
  ffProgressReporter = reporter;
  ffProgressRange = { start: basePct, span: spanPct, label: "変換エンジンで音声をデコード中…" };
  const f = await loadFF(reporter);

  const extMatch = (file.name || "").match(/\.([a-zA-Z0-9]{1,8})$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : "bin";
  const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const outName = `dec_${uid}.pcm`;
  let inputPath = `in_${uid}.${ext}`;
  let mountedDir = null;
  let wroteTempInput = false;

  try {
    try {
      mountedDir = `/mnt_${uid}`;
      await f.createDir(mountedDir);
      await f.mount("WORKERFS", { files: [file] }, mountedDir);
      inputPath = `${mountedDir}/${file.name}`;
    } catch {
      if (mountedDir) {
        try { await f.unmount(mountedDir); } catch {}
        try { await f.deleteDir(mountedDir); } catch {}
        mountedDir = null;
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      await f.writeFile(inputPath, buf);
      wroteTempInput = true;
    }

    reporter(basePct, "変換エンジンで音声をデコード中…", file.name || "");
    await execFF(f, [
      "-y",
      "-i", inputPath,
      "-vn",
      "-sn",
      "-dn",
      "-ac", String(channels),
      "-ar", String(targetSampleRate),
      "-f", "s16le",
      outName
    ]);

    const pcmBytes = await f.readFile(outName);
    if (!pcmBytes || pcmBytes.byteLength < 2) {
      throw new Error("音声トラックが空か、読み取れる音声データが含まれていません。");
    }

    const alignedBuf = pcmBytes.byteOffset % 2 === 0
      ? pcmBytes.buffer
      : pcmBytes.slice().buffer;
    const byteOffset = pcmBytes.byteOffset % 2 === 0 ? pcmBytes.byteOffset : 0;
    const sampleCount = Math.floor(pcmBytes.byteLength / 2);
    const int16 = new Int16Array(alignedBuf, byteOffset, sampleCount);

    if (channels === 1) {
      const mono = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        mono[i] = int16[i] / 32768;
      }
      return mono;
    }

    const frames = Math.floor(sampleCount / 2);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      left[i] = int16[i * 2] / 32768;
      right[i] = int16[i * 2 + 1] / 32768;
    }
    return {
      left,
      right,
      duration: frames / targetSampleRate,
      sampleRate: targetSampleRate
    };
  } finally {
    await cleanupFiles(f, wroteTempInput ? [outName, inputPath] : [outName]);
    if (mountedDir) {
      try { await f.unmount(mountedDir); } catch {}
      try { await f.deleteDir(mountedDir); } catch {}
    }
    ffProgressReporter = editProgress;
  }
}

async function decodeAudioTo16kMono(file) {
  if (!file || file.size === 0) {
    throw new Error("選択されたファイルが空（0バイト）です。別の音声ファイルを選択してください。");
  }
  const targetRate = 16000;
  let mono = null;
  let browserDecodeErr = null;

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (AudioCtx) {
    const ctx = new AudioCtx();
    try {
      let arrayBuffer = await file.arrayBuffer();
      let decoded = await ctx.decodeAudioData(arrayBuffer);
      arrayBuffer = null;

      const targetLength = Math.max(1, Math.ceil(decoded.duration * targetRate));
      const offline = new OfflineAudioContext(1, targetLength, targetRate);
      const srcNode = offline.createBufferSource();
      srcNode.buffer = decoded;
      srcNode.connect(offline.destination);
      srcNode.start(0);
      const rendered = await offline.startRendering();
      mono = new Float32Array(rendered.getChannelData(0));
      decoded = null;
    } catch (err) {
      browserDecodeErr = err;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  if (!mono) {
    try {
      progress(2.5, "ブラウザ非対応形式のため変換エンジンでデコード中…", file.name || "");
      mono = await decodeAudioWithFFmpegFallback(file, 1, targetRate, progress, 3, 2);
    } catch (ffErr) {
      const reason = formatError(ffErr) || formatError(browserDecodeErr);
      throw new Error(
        `音声データをデコードできませんでした（${file.name}）。ファイルが破損しているか、DRM保護・非対応形式の可能性があります。MP3またはWAVに変換してお試しください。（詳細: ${reason}）`
      );
    }
  }

  const decodedDuration = mono.length / targetRate;
  if (!sourceDuration && Number.isFinite(decodedDuration) && decodedDuration > 0) {
    sourceDuration = decodedDuration;
    $("sourceDuration").textContent = `音源の長さ：${fmt(sourceDuration)}`;
    updateExecuteButtonState();
  }

  return mono;
}

let uiProgressTimer = null;
let gpuWatchdogTimer = null;

function stopUiProgressTimer() {
  if (uiProgressTimer) {
    clearInterval(uiProgressTimer);
    uiProgressTimer = null;
  }
}

function stopGpuWatchdog() {
  if (gpuWatchdogTimer) {
    clearTimeout(gpuWatchdogTimer);
    gpuWatchdogTimer = null;
  }
}

function formatTimecodeShort(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function formatEtaShort(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}分${r}秒` : `${r}秒`;
}

function getWorker() {
  if (!activeWorker) {
    activeWorker = new Worker("./transcribe-worker.js?v=0.8.5", { type: "module" });
  }
  return activeWorker;
}

function resetWorker() {
  stopUiProgressTimer();
  stopGpuWatchdog();
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }
}

function runTranscribeWorker(mono16k, forceCpu = false) {
  const worker = getWorker();
  const accelDevice = forceCpu ? "wasm" : ($("accelDevice")?.value || "auto");
  const audioCopy = mono16k.slice();

  let inferState = {
    active: false,
    device: accelDevice === "wasm" ? "wasm" : "webgpu",
    inferStartPct: 25,
    inferEndPct: 96,
    totalBlocks: 1,
    blockIndex: 0,
    blockStartedAt: Date.now(),
    avgBlockMs: 3000,
    winStartSec: 0,
    winEndSec: 15,
    targetDuration: mono16k.length / 16000,
    savedSec: 0,
    lastPct: 5
  };

  const renderSmoothInferUi = () => {
    if (!inferState.active) return;
    const {
      device,
      inferStartPct,
      inferEndPct,
      totalBlocks,
      blockIndex,
      blockStartedAt,
      avgBlockMs,
      winStartSec,
      winEndSec,
      targetDuration,
      savedSec
    } = inferState;

    const spanPct = inferEndPct - inferStartPct;
    const elapsedInBlock = Math.max(0, Date.now() - blockStartedAt);
    // ブロック予定時間を超えても止まらず滑らかに96%まで前進し続ける漸近カーブ
    const expectedMs = Math.max(600, avgBlockMs);
    const intraFraction = 0.96 * (elapsedInBlock / (elapsedInBlock + expectedMs * 0.65));

    const effectiveBlock = Math.min(totalBlocks - 0.02, blockIndex + intraFraction);
    const rawPct = inferStartPct + (effectiveBlock / Math.max(1, totalBlocks)) * spanPct;
    const pct = Math.min(inferEndPct, Math.max(inferState.lastPct, rawPct));
    inferState.lastPct = pct;

    const modeBadge = device === "webgpu" ? "WebGPU高速" : "CPU標準";
    const currentBlockNum = Math.min(totalBlocks, blockIndex + 1);
    const analyzedSec = Math.min(
      targetDuration,
      winStartSec + (winEndSec - winStartSec) * Math.min(1, intraFraction)
    );
    const remainingBlocks = Math.max(0, totalBlocks - effectiveBlock);
    const etaSec = (remainingBlocks * expectedMs) / 1000;
    const vadBadge = savedSec >= 2 ? ` · 無音${Math.round(savedSec)}秒短縮` : "";
    const etaText = etaSec >= 2 ? ` · 残り約 ${formatEtaShort(etaSec)}` : " · まもなく完了";

    progress(
      pct,
      `文字起こし中（${modeBadge} · ブロック ${currentBlockNum}/${totalBlocks}）`,
      `解析: ${formatTimecodeShort(analyzedSec)} / ${formatTimecodeShort(targetDuration)}${vadBadge}${etaText}`
    );
  };

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stopUiProgressTimer();
      stopGpuWatchdog();
      worker.onmessage = null;
      worker.onerror = null;
    };

    const triggerCpuFallback = () => {
      cleanup();
      resetWorker();
      progress(
        Math.max(8, inferState.lastPct),
        "WebGPUが応答しないためCPU標準モードへ自動切替中…",
        "ワーカーを再起動して処理を継続します"
      );
      runTranscribeWorker(mono16k, true).then(resolve, reject);
    };

    const armGpuWatchdog = (ms) => {
      stopGpuWatchdog();
      if (forceCpu || accelDevice === "wasm") return;
      gpuWatchdogTimer = setTimeout(() => {
        triggerCpuFallback();
      }, ms);
    };

    // 初回モデル取得・WebGPUコンパイル監視（35秒応答なしならCPUへ切替）
    armGpuWatchdog(35000);

    worker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === "webgpu-stalled") {
        triggerCpuFallback();
        return;
      }

      if (msg.type === "status" || msg.type === "model-progress") {
        inferState.active = false;
        stopUiProgressTimer();
        const pct = Number.isFinite(msg.percent) ? msg.percent : Number($("progress").value || 10);
        inferState.lastPct = Math.max(inferState.lastPct, pct);
        progress(pct, msg.text || "処理中…", msg.detail || "");
        if (msg.device === "webgpu") {
          armGpuWatchdog(msg.phase === "compiling" ? 25000 : 35000);
        } else if (msg.device === "wasm") {
          stopGpuWatchdog();
        }
      } else if (msg.type === "infer-init") {
        inferState = {
          ...inferState,
          active: true,
          device: msg.device || inferState.device,
          inferStartPct: msg.inferStartPct ?? 25,
          inferEndPct: msg.inferEndPct ?? 96,
          totalBlocks: Math.max(1, msg.totalBlocks || 1),
          blockIndex: 0,
          blockStartedAt: Date.now(),
          avgBlockMs: msg.avgBlockMs || 3000,
          winStartSec: 0,
          winEndSec: Math.min(15, msg.targetDuration || 15),
          targetDuration: msg.targetDuration || inferState.targetDuration,
          savedSec: msg.savedSec || 0,
          lastPct: Math.max(inferState.lastPct, msg.inferStartPct ?? 25)
        };
        if (inferState.device === "webgpu") {
          armGpuWatchdog(20000);
        } else {
          stopGpuWatchdog();
        }
        renderSmoothInferUi();
        stopUiProgressTimer();
        uiProgressTimer = setInterval(renderSmoothInferUi, 200);
      } else if (msg.type === "block-start") {
        inferState.active = true;
        inferState.device = msg.device || inferState.device;
        inferState.blockIndex = msg.blockIndex ?? inferState.blockIndex;
        inferState.totalBlocks = Math.max(1, msg.totalBlocks || inferState.totalBlocks);
        inferState.blockStartedAt = Date.now();
        inferState.winStartSec = msg.winStartSec ?? inferState.winStartSec;
        inferState.winEndSec = msg.winEndSec ?? inferState.winEndSec;
        inferState.avgBlockMs = msg.avgBlockMs || inferState.avgBlockMs;
        if (inferState.device === "webgpu") {
          armGpuWatchdog(msg.blockIndex === 0 ? 20000 : 14000);
        } else {
          stopGpuWatchdog();
        }
        renderSmoothInferUi();
      } else if (msg.type === "block-done") {
        inferState.blockIndex = (msg.blockIndex ?? inferState.blockIndex) + 1;
        inferState.blockStartedAt = Date.now();
        inferState.avgBlockMs = msg.avgBlockMs || inferState.avgBlockMs;
        const spanPct = inferState.inferEndPct - inferState.inferStartPct;
        const exactPct = inferState.inferStartPct + (inferState.blockIndex / inferState.totalBlocks) * spanPct;
        inferState.lastPct = Math.min(inferState.inferEndPct, Math.max(inferState.lastPct, exactPct));
        if (inferState.device === "webgpu") {
          armGpuWatchdog(14000);
        }
        renderSmoothInferUi();
      } else if (msg.type === "result") {
        cleanup();
        const engineTag = msg.deviceUsed === "webgpu" ? "WebGPU高速処理" : "CPU標準処理";
        const savedTag = msg.savedSec >= 2 ? ` · 無音${Math.round(msg.savedSec)}秒スキップ` : "";
        progress(100, `文字起こし完了（${engineTag}）`, `${msg.segments?.length || 0} セグメント抽出${savedTag}`);
        resolve(msg.segments || []);
      } else if (msg.type === "error") {
        cleanup();
        resetWorker();
        reject(new Error(msg.message || "文字起こしワーカーでエラーが発生しました。"));
      }
    };

    worker.onerror = (err) => {
      cleanup();
      resetWorker();
      const loc = err?.filename ? ` (${err.filename}:${err.lineno || 0})` : "";
      reject(new Error((err?.message || "Web Worker の読み込みまたは実行に失敗しました。") + loc));
    };

    worker.postMessage(
      {
        type: "transcribe",
        audio: audioCopy.buffer,
        model: $("model").value,
        language: $("language").value,
        accelDevice,
        skipSilence: $("skipSilenceVad")?.checked !== false
      },
      [audioCopy.buffer]
    );
  });
}

async function transcribe() {
  progress(2, "音声ファイルをデコード中…", "16kHz モノラル形式へ変換しています");
  let mono16k = await decodeAudioTo16kMono(source);
  try {
    progress(5, "AIワーカーへ音声データを転送中…", `${(mono16k.byteLength / 1048576).toFixed(1)} MB`);
    return await runTranscribeWorker(mono16k, false);
  } finally {
    mono16k = null;
  }
}

$("cancelTranscribe").onclick = () => {
  resetWorker();
  stopElapsedTimer();
  $("cancelTranscribe").hidden = true;
  $("transcribe").disabled = !source;
  progress(0, "中止しました", "必要に応じて再実行できます");
};

$("skipTranscribe").onclick = () => {
  $("transcriptCard").hidden = false;
  $("jsonHeading").classList.toggle("subheading", !$("transcriptArea").hidden);
  setActiveStep(3);
  $("transcriptCard").scrollIntoView({ behavior: "smooth", block: "start" });
  $("instructions").focus();
};

$("toggleTranscriptBtn").onclick = () => {
  const willShow = $("transcriptArea").hidden;
  $("transcriptArea").hidden = !willShow;
  $("jsonHeading").classList.toggle("subheading", willShow);
  $("toggleTranscriptBtn").textContent = willShow ? "文字起こし欄を隠す" : "文字起こし欄を表示";
};

$("instructions").addEventListener("input", () => {
  updateSkipTranscribeState();
});

$("transcribe").onclick = async () => {
  if (!source) return;
  $("transcribe").disabled = true;
  $("cancelTranscribe").hidden = false;
  $("progressTimer").textContent = "";
  startElapsedTimer();

  try {
    progress(2, "文字起こしを準備中…");
    segments = await transcribe();
    $("transcript").value = segments.map((s) => `[${fmt(s.start)} - ${fmt(s.end)}] ${s.text}`).join("\n");
    $("transcriptCard").hidden = false;
    $("transcriptArea").hidden = false;
    $("jsonHeading").classList.add("subheading");
    $("toggleTranscriptBtn").textContent = "文字起こし欄を隠す";
    updateTelopStatus();
    setActiveStep(2);
    $("transcriptCard").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    const msg = formatError(e);
    progress(0, "エラー", msg);
    alert("文字起こしに失敗しました: " + msg);
  } finally {
    stopElapsedTimer();
    $("cancelTranscribe").hidden = true;
    $("transcribe").disabled = false;
  }
};

function transcriptObject() {
  return { version: 1, language: $("language").value, source_file: source?.name, segments };
}

function promptText() {
  return `あなたはポッドキャストの編集ディレクターです。以下のタイムスタンプ付き文字起こしを読み、編集指示JSONを作成してください。\n\n方針:\n- 会話の意味を損なわない。発言の途中を切らない。\n- 不要な長い沈黙、明確な言い直し、重複だけを慎重に候補化する。\n- 場面切り替えや話題転換には se（mode:"insert" で割り込み挿入）または marker を置く。\n- BGMは会話を邪魔しない音量にする。\n- フェード（fade）は本編の最初と最後のみに適用する。\n- 不確かな編集は実行せず、notesに理由を書く。\n\n出力は説明文やMarkdown囲みなしのJSONのみ。形式:\n{"version":1,"skip_transcription_if_exists":true,"operations":[{"type":"cut","start":12.5,"end":18.2,"reason":"理由"},{"type":"bgm","start":0,"end":60,"track":"main","volume":0.08,"fade_in":2,"fade_out":3},{"type":"se","time":60,"mode":"insert","duration":1.0,"visual":"black","volume":0.7,"label":"場面切り替え"},{"type":"fade","start":0,"end":1.5,"effect":"in"},{"type":"fade","start":58,"end":60,"effect":"out"},{"type":"marker","time":120,"label":"話題転換"}],"notes":["確認事項"]}\n\n利用可能な操作:\n- cut: start/end秒。音源から区間を削除\n- bgm: start/end秒、trackは"main"、volumeは0〜1、fade_in/fade_outは任意の秒数\n- se: time秒、modeは"insert"（シーン境界に挿入し後ろの音声を押し出す）または"overlay"（重ねて再生）、durationは挿入秒数、visualは"black"（MP4時黒画面）、volumeは0〜1（省略時0.8）、label文字列\n- fade: start/end秒、effectは"in"または"out"\n- marker: time秒、label文字列\n\n時刻はすべて元音源上の秒数です。音源の長さを超えないでください。カット区間を重複させないでください。\n\n文字起こし:\n${$("transcript").value}`;
}

$("copyPrompt").onclick = async () => {
  try {
    await navigator.clipboard.writeText(promptText());
    $("copyPrompt").textContent = "コピーしました";
    setTimeout(() => { $("copyPrompt").textContent = "AI依頼文をコピー"; }, 2500);
  } catch {
    $("transcript").value = promptText();
    alert("クリップボードにコピーできないため、文字起こし欄に依頼文を表示しました。");
  }
};

function dl(text, name, type) {
  const u = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}

$("downloadTranscript").onclick = () => dl($("transcript").value, "transcript.txt", "text/plain;charset=utf-8");
$("downloadTranscriptJson").onclick = () => dl(JSON.stringify(transcriptObject(), null, 2), "transcript.json", "application/json");

bindFileInput($("jsonFile"), async (f) => {
  $("instructions").value = await f.text();
  if ($("jsonFileName")) {
    $("jsonFileName").textContent = `選択中：${f.name}`;
  }
  validate();
});

$("sample").onclick = () => {
  const maxT = sourceDuration && sourceDuration > 10 ? Math.min(45, Math.floor(sourceDuration - 1)) : 45;
  const cutEnd = Math.min(13, maxT);
  const cutStart = Math.min(10, Math.max(0, cutEnd - 2));
  const seTime = Math.min(25, maxT);
  $("instructions").value = JSON.stringify({
    version: 1,
    skip_transcription_if_exists: true,
    operations: [
      { type: "bgm", start: 0, end: maxT, track: "main", volume: 0.08, fade_in: 1.5, fade_out: 2.0 },
      { type: "fade", start: 0, end: 1.5, effect: "in" },
      { type: "cut", start: cutStart, end: cutEnd, reason: "サンプルのカット" },
      { type: "se", time: seTime, mode: "insert", duration: 1.0, visual: "black", volume: 0.7, label: "場面切り替え" },
      { type: "marker", time: seTime, label: "話題転換" },
      { type: "fade", start: Math.max(0, maxT - 2), end: maxT, effect: "out" }
    ],
    notes: ["サンプル指示です。mode:'insert' によりSEの尺だけ後ろの音声が押し出されます。"]
  }, null, 2);
  validate();
};

function parseInstructions() {
  const raw = $("instructions").value.trim();
  if (!raw) throw Error("編集指示JSONが入力されていません。");
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(cleaned);
  const obj = Array.isArray(parsed)
    ? { version: 1, skip_transcription_if_exists: true, operations: parsed }
    : { version: parsed?.version ?? 1, ...parsed };
  if (obj.version !== 1 || !Array.isArray(obj.operations)) {
    throw Error("version:1 と operations 配列が必要です。");
  }
  const ops = obj.operations.map((o, i) => {
    if (!o || !["cut", "bgm", "se", "fade", "marker"].includes(o.type)) {
      throw Error(`操作${i + 1}: 未対応typeです`);
    }
    if (o.type === "marker") {
      if (!Number.isFinite(o.time) || o.time < 0) throw Error(`操作${i + 1}: timeが不正です`);
      return o;
    }
    if (o.type === "se") {
      if (!Number.isFinite(o.time) || o.time < 0) throw Error(`操作${i + 1}: SEのtimeが不正です`);
      if (o.volume != null && (!Number.isFinite(o.volume) || o.volume < 0 || o.volume > 1)) {
        throw Error(`操作${i + 1}: SEのvolumeは0〜1です`);
      }
      if (o.mode != null && !["insert", "overlay"].includes(o.mode)) {
        throw Error(`操作${i + 1}: SEのmodeは"insert"または"overlay"です`);
      }
      if (o.duration != null && (!Number.isFinite(o.duration) || o.duration <= 0)) {
        throw Error(`操作${i + 1}: SEのdurationは0より大きい秒数です`);
      }
      return { ...o, volume: o.volume != null ? o.volume : 0.8 };
    }
    if (!Number.isFinite(o.start) || !Number.isFinite(o.end) || o.start < 0 || o.end <= o.start) {
      throw Error(`操作${i + 1}: start/endが不正です`);
    }
    if (o.type === "bgm" && (!Number.isFinite(o.volume) || o.volume < 0 || o.volume > 1 || (o.track && o.track !== "main"))) {
      throw Error(`操作${i + 1}: BGMのtrackまたはvolumeが不正です`);
    }
    if (o.type === "bgm" && ((o.fade_in != null && (!Number.isFinite(o.fade_in) || o.fade_in < 0)) || (o.fade_out != null && (!Number.isFinite(o.fade_out) || o.fade_out < 0)))) {
      throw Error(`操作${i + 1}: fade_in/fade_outは0以上の秒数です`);
    }
    if (o.type === "fade" && !["in", "out"].includes(o.effect)) {
      throw Error(`操作${i + 1}: effectはin/outです`);
    }
    return o;
  });
  return { ...obj, operations: ops };
}

function resolveSeMode(rawMode) {
  const uiMode = $("seMode")?.value || "auto";
  if (uiMode === "insert" || uiMode === "overlay") return uiMode;
  return rawMode || "insert";
}

function resolveSeInsertDuration(rawDuration) {
  if (Number.isFinite(rawDuration) && rawDuration > 0) return Number(rawDuration);
  if (Number.isFinite(seDuration) && seDuration > 0) return Number(seDuration);
  return 1.0;
}

function getEffectiveSeEvents(operations) {
  const explicitSe = operations
    .filter((o) => o.type === "se")
    .map((o) => {
      const mode = resolveSeMode(o.mode);
      return {
        time: o.time,
        volume: o.volume != null ? o.volume : 0.8,
        label: o.label || "場面切り替えSE",
        mode,
        duration: mode === "insert" ? resolveSeInsertDuration(o.duration) : 0,
        visual: o.visual || "black",
        fromMarker: false
      };
    });

  const combined = [...explicitSe];
  if ($("seOnMarker")?.checked) {
    const markers = operations.filter((o) => o.type === "marker");
    for (const m of markers) {
      const isDuplicate = combined.some((ev) => Math.abs(ev.time - m.time) < 0.15);
      if (!isDuplicate) {
        const mode = resolveSeMode("insert");
        combined.push({
          time: m.time,
          volume: 0.8,
          label: m.label || "話題転換SE",
          mode,
          duration: mode === "insert" ? resolveSeInsertDuration(null) : 0,
          visual: "black",
          fromMarker: true
        });
      }
    }
  }
  return combined.sort((a, b) => a.time - b.time);
}

function updateEstimatedDurationTag() {
  const tagEl = $("estimatedDurationTag");
  if (!tagEl || !validated) return;
  if (!sourceDuration) {
    tagEl.textContent = "完成予定尺: 音源読込後に計算";
    return;
  }
  const cuts = validated.operations.filter((o) => o.type === "cut").sort((a, b) => a.start - b.start);
  const keep = [];
  let cur = 0;
  cuts.forEach((c) => {
    if (c.start > cur) keep.push([cur, c.start]);
    cur = c.end;
  });
  if (cur < sourceDuration) keep.push([cur, sourceDuration]);

  const effectiveSe = getEffectiveSeEvents(validated.operations);
  const insertEvents = effectiveSe.filter((ev) => ev.mode === "insert");
  const introSec = Math.max(0, Math.min(30, Number($("introBgmSec")?.value) || 0));
  const outroSec = Math.max(0, Math.min(30, Number($("outroBgmSec")?.value) || 0));
  const { totalOutDuration } = buildTimelineSegments(keep, insertEvents, introSec, outroSec);
  tagEl.textContent = `完成予定尺: ${fmt(totalOutDuration)}`;
}

function validate() {
  try {
    validated = parseInstructions();
    const cuts = validated.operations.filter((o) => o.type === "cut").sort((a, b) => a.start - b.start);
    for (let i = 1; i < cuts.length; i++) {
      if (cuts[i].start < cuts[i - 1].end) throw Error("カット区間が重複しています。");
    }
    if (sourceDuration) {
      for (const o of validated.operations) {
        const end = o.type === "marker" || o.type === "se" ? o.time : o.end;
        if (end > sourceDuration + 0.05) {
          throw Error(`操作時刻 ${fmt(end)} が音源長 ${fmt(sourceDuration)} を超えています。`);
        }
      }
    }
    const notes = [];
    if (validated.skip_transcription_if_exists) {
      notes.push("文字起こしスキップ有効");
    }
    const effectiveSe = getEffectiveSeEvents(validated.operations);
    const insertCount = effectiveSe.filter((ev) => ev.mode === "insert").length;
    if (insertCount > 0) {
      notes.push(`SE挿入 ${insertCount}箇所（後ろの音声を押し出し）`);
    }

    const introSec = Math.max(0, Number($("introBgmSec")?.value) || 0);
    const outroSec = Math.max(0, Number($("outroBgmSec")?.value) || 0);
    if (introSec > 0 || outroSec > 0) {
      notes.push(`BGMオンリー 冒頭${introSec}s / 終了${outroSec}s`);
    }

    const hasBgm = validated.operations.some((o) => o.type === "bgm");
    if (hasBgm && !bgmTracks.length) {
      notes.push("BGM指示あり：STEP 04でBGMファイルを選択してください");
    } else if (bgmTracks.length >= 2) {
      notes.push(`BGM ${bgmTracks.length}曲プレイリスト`);
    }

    if (effectiveSe.length > 0 && !se) {
      notes.push("SE指示あり：STEP 04で場面切り替えSEファイルを選択してください");
    }

    if ($("format").value === "mp4") {
      if (!thumbnail) notes.push("MP4出力：サムネイル未選択のため単色背景で生成します");
      if ($("enableTelop")?.checked) {
        const cueCount = getActiveTelopSegments().length;
        notes.push(cueCount > 0 ? `テロップON（${cueCount}件）` : "テロップON（字幕データ未読込）");
      }
    }

    if (!source) {
      notes.unshift("文字起こしスキップ可能：STEP 01で収録音源を選択するとすぐ編集を実行できます");
    } else {
      notes.unshift("文字起こし不要：このままSTEP 04で編集を実行できます");
    }

    const suffix = notes.length ? `（${notes.join(" / ")}）` : "";
    $("validation").className = "validation ok";
    $("validation").textContent = `検証OK：${validated.operations.length}件の操作。時刻は元音源基準です。${suffix}`;
    renderOps();
    renderTimeline();
    updateEstimatedDurationTag();
    updateTelopStatus();
    $("editCard").hidden = false;
    setActiveStep(3);
    updateSkipTranscribeState();
    return true;
  } catch (e) {
    validated = null;
    $("validation").className = "validation err";
    $("validation").textContent = "JSONエラー：" + formatError(e);
    $("editCard").hidden = true;
    updateSkipTranscribeState();
    return false;
  }
}

$("validate").onclick = validate;

function renderOps() {
  const el = $("operationList");
  el.innerHTML = "";
  validated.operations.forEach((o) => {
    const d = document.createElement("div");
    d.className = "op";
    const b = document.createElement("b");
    b.textContent = o.type.toUpperCase();
    const s = document.createElement("span");
    if (o.type === "marker") {
      const modeLabel = resolveSeMode("insert") === "insert" ? "挿入" : "重ねる";
      const seBadge = se && $("seOnMarker")?.checked ? ` [SE${modeLabel}対象]` : "";
      s.textContent = `${fmt(o.time)} · ${o.label || ""}${seBadge}`;
    } else if (o.type === "se") {
      const mode = resolveSeMode(o.mode);
      const modeTag = mode === "insert" ? `挿入 ${resolveSeInsertDuration(o.duration).toFixed(1)}s` : "重ねる";
      s.textContent = `${fmt(o.time)} · [${modeTag}] 音量 ${((o.volume ?? 0.8) * 100).toFixed(0)}% · ${o.label || "場面切り替えSE"}`;
    } else if (o.type === "bgm") {
      s.textContent = `${fmt(o.start)} – ${fmt(o.end)} · 音量 ${(o.volume * 100).toFixed(0)}% / IN ${o.fade_in || 0}s / OUT ${o.fade_out || 0}s`;
    } else {
      s.textContent = `${fmt(o.start)} – ${fmt(o.end)} · ${o.reason || o.effect || ""}`;
    }
    d.append(b, s);
    el.append(d);
  });
}

function seekOriginal(seconds) {
  const player = $("originalPreview");
  if (!player.src) return;
  player.currentTime = Math.max(0, seconds);
  player.play().catch(() => {});
}

function renderTimeline() {
  const root = $("timeline");
  root.innerHTML = "";
  const duration = sourceDuration || Math.max(1, ...validated.operations.map((o) => (o.type === "marker" || o.type === "se" ? o.time : o.end)));
  const tracks = [
    { type: "cut", label: "CUT" },
    { type: "bgm", label: "BGM" },
    { type: "se", label: "SE" },
    { type: "fade", label: "FADE" },
    { type: "marker", label: "MARK" }
  ];
  const effectiveSe = getEffectiveSeEvents(validated.operations);

  tracks.forEach((t) => {
    const line = document.createElement("div");
    line.className = "timeline-row";
    const name = document.createElement("b");
    name.textContent = t.label;
    const rail = document.createElement("div");
    rail.className = "timeline-rail";

    const items = t.type === "se"
      ? effectiveSe.map((ev) => ({ type: "se", time: ev.time, label: ev.label, mode: ev.mode, fromMarker: ev.fromMarker }))
      : validated.operations.filter((o) => o.type === t.type);

    items.forEach((o) => {
      const el = document.createElement("span");
      const modeClass = t.type === "se" && o.mode === "insert" ? " insert-mode" : "";
      el.className = `timeline-event ${t.type}${o.fromMarker ? " from-marker" : ""}${modeClass}`;
      const isPoint = t.type === "marker" || t.type === "se";
      const start = isPoint ? o.time : o.start;
      const end = isPoint ? o.time + duration * 0.008 : o.end;
      el.style.left = `${Math.max(0, (start / duration) * 100)}%`;
      el.style.width = `${Math.max(isPoint ? 1.0 : 0.5, ((end - start) / duration) * 100)}%`;
      el.title = isPoint
        ? `${fmt(o.time)} ${o.label || ""}${o.mode === "insert" ? "（挿入）" : ""}`
        : `${fmt(o.start)}-${fmt(o.end)}`;
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", `元音源 ${fmt(start)} に移動`);
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        seekOriginal(start);
      });
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          seekOriginal(start);
        }
      });
      rail.append(el);
    });
    rail.title = "クリックした位置の元音源を再生します";
    rail.addEventListener("click", (ev) => {
      const rect = rail.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      seekOriginal(ratio * duration);
    });
    line.append(name, rail);
    root.append(line);
  });
  $("timelineScale").innerHTML = `<span>00:00</span><span>${fmt(duration / 2)}</span><span>${fmt(duration)}</span>`;
}

function resetFF() {
  if (ff) {
    try {
      ff.terminate();
    } catch {
      // Ignore
    }
  }
  ff = null;
  ffLoadPromise = null;
  ffLogs = [];
}

async function loadFF(reporter = editProgress) {
  ffProgressReporter = reporter;
  if (ff && ff.loaded) return ff;
  if (ffLoadPromise) return ffLoadPromise;

  const isStep1 = reporter === progress;
  const pInit = isStep1 ? 3 : 46;
  const pCore = isStep1 ? 3.5 : 50;
  const pWasm = isStep1 ? 4 : 55;
  const pReady = isStep1 ? 4.5 : 60;

  ffLoadPromise = (async () => {
    ffProgressReporter(pInit, "変換エンジンを読み込み中…", "@ffmpeg/ffmpeg");
    const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
      import("https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js"),
      import("https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js")
    ]);
    const instance = new FFmpeg();
    ffLogs = [];
    instance.on("log", ({ message }) => {
      if (!message) return;
      ffLogs.push(message);
      if (ffLogs.length > 30) ffLogs.shift();
    });
    instance.on("progress", ({ progress: p }) => {
      const ratio = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
      const pct = Math.min(95, ffProgressRange.start + ratio * ffProgressRange.span);
      ffProgressReporter(pct, ffProgressRange.label, `${Math.round(ratio * 100)}%`);
    });
    const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
    const workerCode = 'import "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/worker.js";';
    const classWorkerURL = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
    ffProgressReporter(pCore, "FFmpegコアをダウンロード中…", "初回のみエンジンを取得します");
    const coreURL = await toBlobURL(base + "/ffmpeg-core.js", "text/javascript");
    ffProgressReporter(pWasm, "FFmpeg WASMをダウンロード中…", "ffmpeg-core.wasm");
    const wasmURL = await toBlobURL(base + "/ffmpeg-core.wasm", "application/wasm");
    ffProgressReporter(pReady, "FFmpegエンジンを初期化中…", "");
    await instance.load({ classWorkerURL, coreURL, wasmURL });
    URL.revokeObjectURL(classWorkerURL);
    if (!instance.loaded) {
      throw new Error("FFmpegの初期化が完了しませんでした。");
    }
    ff = instance;
    return ff;
  })();

  try {
    return await ffLoadPromise;
  } catch (err) {
    resetFF();
    throw new Error(formatError(err));
  }
}

async function execFF(f, args) {
  ffLogs = [];
  const exitCode = await f.exec(args);
  if (exitCode !== 0) {
    const recentLogs = ffLogs
      .filter((line) => /error|invalid|failed|cannot|no such|unable|not found|out of memory/i.test(line))
      .slice(-4);
    const fallbackLogs = ffLogs.slice(-4);
    const detail = (recentLogs.length ? recentLogs : fallbackLogs).join(" / ");
    throw new Error(`変換エンジンエラー (code=${exitCode})${detail ? `: ${detail}` : ""}`);
  }
}

function buildTimelineSegments(keep, insertEvents, introSec = 0, outroSec = 0) {
  const sortedInserts = [...insertEvents].sort((a, b) => a.time - b.time);
  const usedInsertIndices = new Set();
  const timeline = [];
  let outCursor = 0;

  if (introSec > 0.01) {
    timeline.push({ kind: "intro", outStart: 0, outEnd: introSec });
    outCursor += introSec;
  }

  for (let kIdx = 0; kIdx < keep.length; kIdx++) {
    const [ks, ke] = keep[kIdx];
    const isLastKeep = kIdx === keep.length - 1;
    let subCur = ks;

    for (let i = 0; i < sortedInserts.length; i++) {
      if (usedInsertIndices.has(i)) continue;
      const ev = sortedInserts[i];
      const inRange = (ev.time >= ks && ev.time < ke) || (isLastKeep && Math.abs(ev.time - ke) < 0.05);
      if (!inRange) continue;

      usedInsertIndices.add(i);
      const splitPoint = Math.min(ke, Math.max(ks, ev.time));
      if (splitPoint > subCur + 0.001) {
        const pieceDur = splitPoint - subCur;
        timeline.push({
          kind: "source",
          origStart: subCur,
          origEnd: splitPoint,
          outStart: outCursor,
          outEnd: outCursor + pieceDur
        });
        outCursor += pieceDur;
      }

      const insDur = Math.max(0.05, Number(ev.duration) || 1.0);
      timeline.push({
        kind: "insert",
        origTime: splitPoint,
        outStart: outCursor,
        outEnd: outCursor + insDur,
        seEvent: ev
      });
      outCursor += insDur;
      subCur = splitPoint;
    }

    if (ke > subCur + 0.001) {
      const pieceDur = ke - subCur;
      timeline.push({
        kind: "source",
        origStart: subCur,
        origEnd: ke,
        outStart: outCursor,
        outEnd: outCursor + pieceDur
      });
      outCursor += pieceDur;
    }
  }

  const talkEndOut = outCursor;

  if (outroSec > 0.01) {
    timeline.push({ kind: "outro", outStart: outCursor, outEnd: outCursor + outroSec });
    outCursor += outroSec;
  }

  return { timeline, totalOutDuration: outCursor, talkEndOut };
}

function mapOriginalToOutput(origTime, timeline, talkEndOut) {
  for (const seg of timeline) {
    if (seg.kind === "source") {
      if (origTime <= seg.origStart) return seg.outStart;
      if (origTime < seg.origEnd) return seg.outStart + (origTime - seg.origStart);
    } else if (seg.kind === "insert") {
      if (origTime <= seg.origTime) return seg.outEnd;
    }
  }
  return talkEndOut;
}

function scheduleBgmSegments({
  winStart,
  winEnd,
  baseVolume,
  fadeIn,
  fadeOut,
  tracks,
  sceneTransitions,
  autoSwitch,
  thresholdSec,
  crossfadeSec,
  startTrackOffset = 0
}) {
  const totalWin = winEnd - winStart;
  if (totalWin <= 0.05 || !tracks.length) return { segments: [], nextTrackOffset: startTrackOffset };

  if (tracks.length === 1 || !autoSwitch) {
    return {
      segments: [{
        trackIndex: startTrackOffset % tracks.length,
        outStart: winStart,
        outEnd: winEnd,
        fadeIn: Math.min(fadeIn, totalWin),
        fadeOut: Math.min(fadeOut, totalWin),
        baseVolume
      }],
      nextTrackOffset: startTrackOffset
    };
  }

  const scheduled = [];
  let curTime = winStart;
  let trackIdx = startTrackOffset;
  let safetyCounter = 0;

  while (curTime < winEnd - 0.05 && safetyCounter < 200) {
    safetyCounter += 1;
    const tIndex = trackIdx % tracks.length;
    const track = tracks[tIndex];
    const trackDur = Number.isFinite(track.duration) && track.duration > 3 ? track.duration : 180;
    const naturalEnd = curTime + trackDur;
    const earliestSwitch = Math.max(curTime + 4, naturalEnd - thresholdSec);

    const transition = sceneTransitions.find(
      (tr) => tr.start >= earliestSwitch && tr.start < winEnd - 1.0 && tr.start > curTime + 2.0
    );

    if (transition) {
      const isInsert = transition.end > transition.start + 0.01;
      const segEnd = isInsert
        ? transition.start
        : Math.min(winEnd, transition.start + crossfadeSec * 0.5);
      const nextStart = isInsert
        ? transition.end
        : Math.max(curTime + 0.5, transition.start - crossfadeSec * 0.5);

      const segDur = segEnd - curTime;
      if (segDur > 0.1) {
        const isFirst = scheduled.length === 0;
        const outFade = isInsert
          ? Math.min(0.6, segDur * 0.35)
          : Math.min(crossfadeSec, segDur * 0.45);
        scheduled.push({
          trackIndex: tIndex,
          outStart: curTime,
          outEnd: segEnd,
          fadeIn: isFirst ? Math.min(fadeIn, segDur) : Math.min(crossfadeSec, segDur * 0.45),
          fadeOut: outFade,
          baseVolume
        });
      }
      curTime = nextStart;
      trackIdx += 1;
      continue;
    }

    if (naturalEnd < winEnd - 1.0) {
      const segDur = naturalEnd - curTime;
      const isFirst = scheduled.length === 0;
      const xf = Math.min(crossfadeSec, segDur * 0.4, (winEnd - naturalEnd) * 0.4);
      scheduled.push({
        trackIndex: tIndex,
        outStart: curTime,
        outEnd: naturalEnd,
        fadeIn: isFirst ? Math.min(fadeIn, segDur) : xf,
        fadeOut: xf,
        baseVolume
      });
      curTime = Math.max(curTime + 0.5, naturalEnd - xf);
      trackIdx += 1;
      continue;
    }

    const finalDur = winEnd - curTime;
    const isFirst = scheduled.length === 0;
    scheduled.push({
      trackIndex: tIndex,
      outStart: curTime,
      outEnd: winEnd,
      fadeIn: isFirst ? Math.min(fadeIn, finalDur) : Math.min(crossfadeSec, finalDur * 0.45),
      fadeOut: Math.min(fadeOut, finalDur),
      baseVolume
    });
    trackIdx += 1;
    break;
  }

  return { segments: scheduled, nextTrackOffset: trackIdx };
}

async function getDuration(file) {
  return new Promise((resolve, reject) => {
    const u = URL.createObjectURL(file);
    const a = new Audio();
    a.onloadedmetadata = () => {
      URL.revokeObjectURL(u);
      resolve(a.duration);
    };
    a.onerror = () => {
      URL.revokeObjectURL(u);
      reject(Error("音源の長さを読み取れません。"));
    };
    a.src = u;
  });
}

async function decodeFileToStereo(file, targetSampleRate) {
  if (!file || file.size === 0) {
    throw new Error("音声ファイルが空（0バイト）です。");
  }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (AudioCtx) {
    const ctx = new AudioCtx();
    try {
      let arrayBuffer = await file.arrayBuffer();
      let decoded = await ctx.decodeAudioData(arrayBuffer);
      arrayBuffer = null;

      const duration = decoded.duration;
      if (decoded.sampleRate === targetSampleRate) {
        const left = new Float32Array(decoded.getChannelData(0));
        const right = decoded.numberOfChannels > 1
          ? new Float32Array(decoded.getChannelData(1))
          : new Float32Array(left);
        decoded = null;
        return { left, right, duration, sampleRate: targetSampleRate };
      }

      const targetLength = Math.max(1, Math.ceil(duration * targetSampleRate));
      const offline = new OfflineAudioContext(2, targetLength, targetSampleRate);
      const srcNode = offline.createBufferSource();
      srcNode.buffer = decoded;
      srcNode.connect(offline.destination);
      srcNode.start(0);
      const rendered = await offline.startRendering();
      const left = new Float32Array(rendered.getChannelData(0));
      const right = new Float32Array(rendered.getChannelData(1));
      decoded = null;
      return { left, right, duration, sampleRate: targetSampleRate };
    } catch {
      // Fallback to FFmpeg below
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  try {
    return await decodeAudioWithFFmpegFallback(file, 2, targetSampleRate, editProgress, 9, 5);
  } catch (ffErr) {
    throw new Error(
      `音声データをデコードできませんでした（${file.name}）。ファイルが破損しているか、非対応形式の可能性があります。（詳細: ${formatError(ffErr)}）`
    );
  }
}

function encodeStereoWav(left, right, sampleRate) {
  const numSamples = left.length;
  const bytesPerSample = 2;
  const numChannels = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    view.setInt16(offset + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    offset += 4;
  }

  return new Uint8Array(buffer);
}

// --- Lightweight JPEG + Telop Frame Rendering ---
function wrapSubtitleLines(ctx, text, maxWidth) {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  const lines = [];
  let current = "";

  for (const ch of chars) {
    const test = current + ch;
    if (ctx.measureText(test).width > maxWidth && current.length > 0) {
      lines.push(current);
      current = ch;
      if (lines.length >= 2) break;
    } else {
      current = test;
    }
  }
  if (current && lines.length < 2) {
    lines.push(current);
  } else if (current && lines.length === 2) {
    lines[1] = lines[1].slice(0, Math.max(1, lines[1].length - 1)) + "…";
  }
  return lines;
}

function drawTelopOnCanvas(ctx, width, height, text, { sizeKey, styleKey, posKey }) {
  const scaleRatio = width / 1280;
  const baseFontSize = sizeKey === "small" ? 30 : sizeKey === "large" ? 46 : 38;
  const fontSize = Math.max(16, Math.round(baseFontSize * scaleRatio));
  ctx.font = `700 ${fontSize}px "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Noto Sans JP", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lines = wrapSubtitleLines(ctx, text, width - Math.round(140 * scaleRatio));
  if (!lines.length) return;

  const lineHeight = Math.round(fontSize * 1.34);
  const totalTextH = lines.length * lineHeight;
  const maxLineW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const centerY = posKey === "top"
    ? Math.round(height * 0.14)
    : posKey === "center"
      ? Math.round(height * 0.50)
      : Math.round(height * 0.84);

  if (styleKey === "band") {
    const padX = Math.round(28 * scaleRatio);
    const padY = Math.round(14 * scaleRatio);
    const boxW = Math.min(width - Math.round(64 * scaleRatio), maxLineW + padX * 2);
    const boxH = totalTextH + padY * 2;
    const boxX = (width - boxW) / 2;
    const boxY = centerY - boxH / 2;
    const r = Math.round(12 * scaleRatio);

    ctx.fillStyle = "rgba(8, 13, 26, 0.80)";
    ctx.beginPath();
    ctx.moveTo(boxX + r, boxY);
    ctx.lineTo(boxX + boxW - r, boxY);
    ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + r);
    ctx.lineTo(boxX + boxW, boxY + boxH - r);
    ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - r, boxY + boxH);
    ctx.lineTo(boxX + r, boxY + boxH);
    ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - r);
    ctx.lineTo(boxX, boxY + r);
    ctx.quadraticCurveTo(boxX, boxY, boxX + r, boxY);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  const startY = centerY - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, idx) => {
    const y = startY + idx * lineHeight;
    if (styleKey === "outline" || styleKey === "yellow") {
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(3, Math.round(fontSize * 0.22));
      ctx.strokeStyle = "rgba(0, 0, 0, 0.92)";
      ctx.strokeText(line, width / 2, y);
    }
    ctx.fillStyle = styleKey === "yellow" ? "#fde047" : "#ffffff";
    ctx.fillText(line, width / 2, y);
  });
}

async function createBaseCanvas(thumbnailFile, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0b1120";
  ctx.fillRect(0, 0, width, height);

  if (thumbnailFile) {
    const imgUrl = URL.createObjectURL(thumbnailFile);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("サムネイル画像のデコードに失敗しました。"));
        el.src = imgUrl;
      });
      const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
      const drawW = Math.round(img.naturalWidth * scale);
      const drawH = Math.round(img.naturalHeight * scale);
      const drawX = Math.round((width - drawW) / 2);
      const drawY = Math.round((height - drawH) / 2);
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
    } finally {
      URL.revokeObjectURL(imgUrl);
    }
  }
  return canvas;
}

async function canvasToJpegBytes(canvas, quality = 0.84) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

function mapSubtitleCuesToOutput(rawSegments, timeline) {
  const sourcePieces = timeline.filter((seg) => seg.kind === "source");
  const cues = [];

  for (const seg of rawSegments) {
    const text = String(seg.text || "").trim();
    if (!text) continue;
    for (const piece of sourcePieces) {
      const ovStart = Math.max(seg.start, piece.origStart);
      const ovEnd = Math.min(seg.end, piece.origEnd);
      if (ovEnd > ovStart + 0.05) {
        cues.push({
          outStart: piece.outStart + (ovStart - piece.origStart),
          outEnd: piece.outStart + (ovEnd - piece.origStart),
          text
        });
      }
    }
  }

  return cues.sort((a, b) => a.outStart - b.outStart);
}

async function mixAudioInMemory({
  duration,
  timeline,
  totalOutDuration,
  talkEndOut,
  introSec,
  outroSec,
  boostSolo,
  allSeEvents,
  bgmOps,
  insertSeEvents,
  overlaySeEvents,
  fades,
  sampleRate
}) {
  const totalSamples = Math.max(1, Math.ceil(totalOutDuration * sampleRate));
  const outL = new Float32Array(totalSamples);
  const outR = new Float32Array(totalSamples);

  // 1. 元音源のデコードとカット区間コピー
  editProgress(8, "元音源をデコード中…");
  let srcData = await decodeFileToStereo(source, sampleRate);
  const declickSamples = Math.max(1, Math.floor(0.003 * sampleRate));

  editProgress(16, "カット区間とタイムラインを構築中…");
  for (const seg of timeline) {
    if (seg.kind !== "source") continue;
    const srcStart = Math.max(0, Math.floor(seg.origStart * sampleRate));
    const srcEnd = Math.min(srcData.left.length, Math.floor(seg.origEnd * sampleRate));
    const dstStart = Math.max(0, Math.floor(seg.outStart * sampleRate));
    const copyLen = Math.min(srcEnd - srcStart, totalSamples - dstStart);
    if (copyLen <= 0) continue;

    outL.set(srcData.left.subarray(srcStart, srcStart + copyLen), dstStart);
    outR.set(srcData.right.subarray(srcStart, srcStart + copyLen), dstStart);

    const ramp = Math.min(declickSamples, Math.floor(copyLen / 4));
    if (seg.origStart > 0.01) {
      for (let j = 0; j < ramp; j++) {
        const g = j / ramp;
        outL[dstStart + j] *= g;
        outR[dstStart + j] *= g;
      }
    }
    if (seg.origEnd < duration - 0.01) {
      for (let j = 0; j < ramp; j++) {
        const g = j / ramp;
        const idx = dstStart + copyLen - 1 - j;
        outL[idx] *= g;
        outR[idx] *= g;
      }
    }
  }
  srcData = null;

  // 2. BGM合成（複数区間でも曲順引き継ぎ・イントロ/アウトロ音量ブースト・SE挿入時ミュート対応）
  const effectiveBgmOps = bgmOps.length
    ? bgmOps
    : (bgmTracks.length > 0
        ? [{ start: 0, end: duration, volume: 0.08, fade_in: Math.min(2, introSec || 1.5), fade_out: Math.min(2.5, outroSec || 2.0) }]
        : []);

  if (effectiveBgmOps.length && bgmTracks.length) {
    const sceneTransitions = [];
    for (const seg of timeline) {
      if (seg.kind === "insert") {
        sceneTransitions.push({ start: seg.outStart, end: seg.outEnd });
      }
    }
    for (const ev of allSeEvents) {
      if (ev.mode === "insert") continue;
      const tOut = mapOriginalToOutput(ev.time, timeline, talkEndOut);
      if (!sceneTransitions.some((tr) => Math.abs(tr.start - tOut) < 0.25)) {
        sceneTransitions.push({ start: tOut, end: tOut });
      }
    }
    sceneTransitions.sort((a, b) => a.start - b.start);

    const autoSwitch = $("bgmAutoSwitch")?.checked !== false;
    const thresholdSec = Math.max(5, Number($("bgmSwitchThreshold")?.value) || 20);
    const crossfadeSec = Math.max(0, Number($("bgmCrossfadeSec")?.value) || 1.5);
    const muteOnInsert = $("muteBgmOnInsert")?.checked !== false;
    const muteRanges = muteOnInsert
      ? timeline
          .filter((seg) => seg.kind === "insert")
          .map((seg) => [Math.floor(seg.outStart * sampleRate), Math.floor(seg.outEnd * sampleRate)])
      : [];
    const duckRamp = Math.max(1, Math.floor(0.012 * sampleRate));

    const segsByTrack = new Map();
    let trackOffset = 0;

    for (const op of effectiveBgmOps) {
      const winStart = op.start <= 0.05 ? 0 : mapOriginalToOutput(op.start, timeline, talkEndOut);
      const winEnd = op.end >= duration - 0.05
        ? totalOutDuration
        : mapOriginalToOutput(op.end, timeline, talkEndOut);
      if (winEnd - winStart <= 0.05) continue;

      const { segments: scheduledSegs, nextTrackOffset } = scheduleBgmSegments({
        winStart,
        winEnd,
        baseVolume: op.volume,
        fadeIn: Number(op.fade_in || 0),
        fadeOut: Number(op.fade_out || 0),
        tracks: bgmTracks,
        sceneTransitions,
        autoSwitch,
        thresholdSec,
        crossfadeSec,
        startTrackOffset: trackOffset
      });
      trackOffset = nextTrackOffset;

      for (const seg of scheduledSegs) {
        if (seg.outEnd - seg.outStart <= 0.05) continue;
        if (!segsByTrack.has(seg.trackIndex)) segsByTrack.set(seg.trackIndex, []);
        segsByTrack.get(seg.trackIndex).push(seg);
      }
    }

    const activeTrackIndices = Array.from(segsByTrack.keys()).sort((a, b) => a - b);
    const rampInSec = Math.min(1.2, introSec * 0.45);
    const rampOutSec = Math.min(1.2, outroSec * 0.45);

    for (let tStep = 0; tStep < activeTrackIndices.length; tStep++) {
      const tIdx = activeTrackIndices[tStep];
      const tr = bgmTracks[tIdx];
      editProgress(
        22 + Math.round((tStep / Math.max(1, activeTrackIndices.length)) * 12),
        `BGMを合成中（${tStep + 1}/${activeTrackIndices.length}曲目）…`,
        tr.name
      );

      let bgmData = await decodeFileToStereo(tr.file, sampleRate);
      const bgmLen = Math.max(1, bgmData.left.length);

      for (const seg of segsByTrack.get(tIdx)) {
        const startIdx = Math.max(0, Math.floor(seg.outStart * sampleRate));
        const endIdx = Math.min(totalSamples, Math.floor(seg.outEnd * sampleRate));
        const fadeInSamples = Math.floor(seg.fadeIn * sampleRate);
        const fadeOutSamples = Math.floor(seg.fadeOut * sampleRate);
        const baseVol = seg.baseVolume;
        const soloVol = Math.min(0.45, Math.max(baseVol * 2.2, baseVol + 0.08));

        for (let i = startIdx; i < endIdx; i++) {
          let muteMult = 1;
          for (let m = 0; m < muteRanges.length; m++) {
            const [ms, me] = muteRanges[m];
            if (i >= ms && i < me) {
              muteMult = 0;
              break;
            }
            if (i >= ms - duckRamp && i < ms) {
              muteMult = Math.min(muteMult, (ms - i) / duckRamp);
            } else if (i >= me && i < me + duckRamp) {
              muteMult = Math.min(muteMult, (i - me) / duckRamp);
            }
          }
          if (muteMult <= 0) continue;

          let effectiveBase = baseVol;
          if (boostSolo && soloVol > baseVol) {
            const tSec = i / sampleRate;
            let soloFactor = 0;
            if (introSec > 0.05 && tSec < introSec) {
              const holdEnd = introSec - rampInSec;
              soloFactor = tSec <= holdEnd ? 1 : Math.max(0, (introSec - tSec) / Math.max(0.01, rampInSec));
            } else if (outroSec > 0.05 && tSec >= talkEndOut) {
              const rampEnd = talkEndOut + rampOutSec;
              soloFactor = tSec >= rampEnd ? 1 : Math.max(0, (tSec - talkEndOut) / Math.max(0.01, rampOutSec));
            }
            effectiveBase = baseVol + (soloVol - baseVol) * soloFactor;
          }

          const rel = i - startIdx;
          let gain = effectiveBase * muteMult;
          if (fadeInSamples > 0 && rel < fadeInSamples) {
            gain *= rel / fadeInSamples;
          }
          const rem = endIdx - 1 - i;
          if (fadeOutSamples > 0 && rem < fadeOutSamples) {
            gain *= rem / fadeOutSamples;
          }

          const bIdx = rel % bgmLen;
          outL[i] += bgmData.left[bIdx] * gain;
          outR[i] += bgmData.right[bIdx] * gain;
        }
      }
      bgmData = null;
    }
  }

  // 3. SE合成（insert区間およびoverlay位置）
  if (se && (insertSeEvents.length || overlaySeEvents.length)) {
    editProgress(35, "効果音（SE）を配置中…");
    let seData = await decodeFileToStereo(se, sampleRate);

    for (const seg of timeline) {
      if (seg.kind !== "insert") continue;
      const dstStart = Math.max(0, Math.floor(seg.outStart * sampleRate));
      const maxSamples = Math.floor(Math.max(0.05, seg.outEnd - seg.outStart) * sampleRate);
      const copyLen = Math.min(seData.left.length, maxSamples, totalSamples - dstStart);
      const vol = seg.seEvent.volume;
      for (let j = 0; j < copyLen; j++) {
        outL[dstStart + j] += seData.left[j] * vol;
        outR[dstStart + j] += seData.right[j] * vol;
      }
    }

    for (const ev of overlaySeEvents) {
      const outputStart = mapOriginalToOutput(ev.time, timeline, talkEndOut);
      const dstStart = Math.max(0, Math.floor(outputStart * sampleRate));
      const copyLen = Math.min(seData.left.length, totalSamples - dstStart);
      const vol = ev.volume;
      for (let j = 0; j < copyLen; j++) {
        outL[dstStart + j] += seData.left[j] * vol;
        outR[dstStart + j] += seData.right[j] * vol;
      }
    }
    seData = null;
  }

  // 4. 全体・区間フェード処理
  if (fades.length) {
    editProgress(40, "フェードを適用中…");
    for (const o of fades) {
      const d = Math.max(0.01, o.end - o.start);
      let st;
      if (o.effect === "out" && o.end >= duration - 0.1) {
        st = Math.max(0, totalOutDuration - d);
      } else if (o.effect === "in" && o.start <= 0.05) {
        st = 0;
      } else {
        st = mapOriginalToOutput(o.start, timeline, talkEndOut);
      }
      const fStart = Math.max(0, Math.floor(st * sampleRate));
      const fEnd = Math.min(totalSamples, Math.floor((st + d) * sampleRate));
      const fLen = Math.max(1, fEnd - fStart);
      for (let i = fStart; i < fEnd; i++) {
        const t = (i - fStart) / fLen;
        const g = o.effect === "out" ? (1 - t) : t;
        outL[i] *= g;
        outR[i] *= g;
      }
    }
  }

  return { outL, outR };
}

async function cleanupFiles(f, names) {
  for (const name of names) {
    try {
      await f.deleteFile(name);
    } catch {
      // Ignore cleanup failure
    }
  }
}

async function render() {
  if (!source) throw Error("元音源ファイルが選択されていません。");
  const obj = validated || parseInstructions();
  const duration = sourceDuration || (await getDuration(source));
  const ops = obj.operations.filter((o) => o.type !== "marker");
  const format = $("format").value;

  for (const o of obj.operations) {
    const end = o.type === "marker" || o.type === "se" ? o.time : o.end;
    if (end > duration + 0.05) {
      throw Error(`編集時刻 ${end.toFixed(1)}秒が音源長 ${duration.toFixed(1)}秒を超えています。`);
    }
  }

  const cuts = ops.filter((o) => o.type === "cut").sort((a, b) => a.start - b.start);
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i].start < cuts[i - 1].end) throw Error("カット区間が重複しています。");
  }

  const keep = [];
  let cur = 0;
  cuts.forEach((c) => {
    if (c.start > cur) keep.push([cur, c.start]);
    cur = c.end;
  });
  if (cur < duration) keep.push([cur, duration]);
  if (!keep.length) throw Error("音声全体がカットされています。");

  const bgmOps = ops.filter((o) => o.type === "bgm");
  if (bgmOps.length && !bgmTracks.length) {
    throw Error("BGM指示がありますが、BGMファイルが選択されていません。");
  }

  const allSeEvents = getEffectiveSeEvents(obj.operations);
  if (allSeEvents.length > 0 && !se) {
    throw Error("SE指示がありますが、場面切り替えSEファイルが選択されていません。");
  }

  const useTelop = format === "mp4" && Boolean($("enableTelop")?.checked);
  const rawTelopSegs = useTelop ? getActiveTelopSegments() : [];
  if (useTelop && !rawTelopSegs.length) {
    throw Error("テロップが有効ですが、字幕データがありません。STEP 01で文字起こしを実行するか、STEP 04で字幕ファイルを読み込んでください。");
  }

  resetWorker();

  const profile = getDeviceProfile(duration);
  const sampleRate = format === "wav" ? 44100 : profile.sampleRate;
  const introSec = Math.max(0, Math.min(30, Number($("introBgmSec")?.value) || 0));
  const outroSec = Math.max(0, Math.min(30, Number($("outroBgmSec")?.value) || 0));
  const boostSolo = $("boostBgmOnSolo")?.checked !== false;

  const insertSeEvents = se ? allSeEvents.filter((ev) => ev.mode === "insert") : [];
  const overlaySeEvents = se ? allSeEvents.filter((ev) => ev.mode !== "insert") : [];
  const fades = ops.filter((o) => o.type === "fade");
  const { timeline, totalOutDuration, talkEndOut } = buildTimelineSegments(keep, insertSeEvents, introSec, outroSec);

  // STEP 1: ブラウザ標準の高速メモリ処理で全音声を合成
  let mixed = await mixAudioInMemory({
    duration,
    timeline,
    totalOutDuration,
    talkEndOut,
    introSec,
    outroSec,
    boostSolo,
    allSeEvents,
    bgmOps,
    insertSeEvents,
    overlaySeEvents,
    fades,
    sampleRate
  });

  editProgress(44, "完成音声データを生成中…");
  let wavBytes = encodeStereoWav(mixed.outL, mixed.outR, sampleRate);
  mixed = null;

  if (format === "wav") {
    const blob = new Blob([wavBytes], { type: "audio/wav" });
    wavBytes = null;
    return blob;
  }

  // STEP 2: MP3 / MP4 のみ完成済みWAV（＋軽量JPEG）をFFmpegで単発エンコード
  const f = await loadFF();
  const tempFiles = ["mix.wav"];

  try {
    editProgress(62, "音声データを変換エンジンへ転送中…");
    await f.writeFile("mix.wav", wavBytes);
    wavBytes = null;

    if (format === "mp3") {
      tempFiles.push("final.mp3");
      ffProgressRange = { start: 65, span: 28, label: "MP3形式で書き出し中…" };
      editProgress(65, "MP3形式で書き出し中…");
      await execFF(f, ["-y", "-i", "mix.wav", "-c:a", "libmp3lame", "-b:a", "192k", "final.mp3"]);
      await cleanupFiles(f, ["mix.wav"]);
      editProgress(95, "出力ファイルを生成中…");
      const data = await f.readFile("final.mp3");
      return new Blob([data.buffer], { type: "audio/mpeg" });
    }

    // MP4出力
    const w = profile.videoWidth;
    const h = profile.videoHeight;
    const blackSegs = timeline.filter((seg) => seg.kind === "insert" && seg.seEvent?.visual === "black");
    const mappedCues = useTelop ? mapSubtitleCuesToOutput(rawTelopSegs, timeline) : [];

    // テロップも暗転も無い場合は1枚のJPEGループで超高速出力
    if (!mappedCues.length && !blackSegs.length) {
      editProgress(63, "サムネイル画像を最適化中…", `${w}×${h}`);
      const baseCanvas = await createBaseCanvas(thumbnail, w, h);
      let jpegBytes = await canvasToJpegBytes(baseCanvas, 0.85);
      baseCanvas.width = 0;
      baseCanvas.height = 0;

      tempFiles.push("thumb.jpg", "final.mp4");
      await f.writeFile("thumb.jpg", jpegBytes);
      jpegBytes = null;

      ffProgressRange = { start: 66, span: 28, label: "MP4動画をエンコード中…" };
      editProgress(66, "MP4動画をエンコード中…");
      await execFF(f, [
        "-y",
        "-loop", "1",
        "-framerate", "1",
        "-t", Math.max(0.1, totalOutDuration).toFixed(3),
        "-i", "thumb.jpg",
        "-i", "mix.wav",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "libx264",
        "-tune", "stillimage",
        "-preset", "ultrafast",
        "-rc-lookahead", "0",
        "-refs", "1",
        "-bf", "0",
        "-crf", profile.crf,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "final.mp4"
      ]);
      await cleanupFiles(f, ["thumb.jpg", "mix.wav"]);
      editProgress(95, "出力ファイルを生成中…");
      const data = await f.readFile("final.mp4");
      return new Blob([data.buffer], { type: "video/mp4" });
    }

    // テロップまたはSE暗転がある場合はCanvas合成済み軽量JPEG＋concatデマルチプレクサで処理
    editProgress(63, "テロップ・画面フレームを生成中…", `${w}×${h}`);
    const baseCanvas = await createBaseCanvas(thumbnail, w, h);
    const workCanvas = document.createElement("canvas");
    workCanvas.width = w;
    workCanvas.height = h;
    const workCtx = workCanvas.getContext("2d");

    tempFiles.push("f_base.jpg", "frames.txt", "final.mp4");
    await f.writeFile("f_base.jpg", await canvasToJpegBytes(baseCanvas, 0.84));

    if (blackSegs.length) {
      workCtx.fillStyle = "#000000";
      workCtx.fillRect(0, 0, w, h);
      tempFiles.push("f_black.jpg");
      await f.writeFile("f_black.jpg", await canvasToJpegBytes(workCanvas, 0.80));
    }

    const sizeKey = $("telopSize")?.value || "medium";
    const styleKey = $("telopStyle")?.value || "band";
    const posKey = $("telopPosition")?.value || "bottom";

    const cueFiles = [];
    for (let i = 0; i < mappedCues.length; i++) {
      if (i % 15 === 0) {
        const subPct = 63 + Math.min(4, Math.round((i / Math.max(1, mappedCues.length)) * 4));
        editProgress(subPct, "テロップ画像を生成中…", `${i + 1}/${mappedCues.length}枚`);
      }
      workCtx.clearRect(0, 0, w, h);
      workCtx.drawImage(baseCanvas, 0, 0);
      drawTelopOnCanvas(workCtx, w, h, mappedCues[i].text, { sizeKey, styleKey, posKey });
      const fname = `f_c${i}.jpg`;
      tempFiles.push(fname);
      await f.writeFile(fname, await canvasToJpegBytes(workCanvas, 0.84));
      cueFiles.push({ fname, outStart: mappedCues[i].outStart, outEnd: mappedCues[i].outEnd });
    }

    baseCanvas.width = 0;
    baseCanvas.height = 0;
    workCanvas.width = 0;
    workCanvas.height = 0;

    // タイムライン上の切替点を収集して視覚区間リストを構築
    const points = new Set([0, totalOutDuration]);
    for (const b of blackSegs) {
      if (b.outStart > 0 && b.outStart < totalOutDuration) points.add(b.outStart);
      if (b.outEnd > 0 && b.outEnd < totalOutDuration) points.add(b.outEnd);
    }
    for (const c of cueFiles) {
      if (c.outStart > 0 && c.outStart < totalOutDuration) points.add(c.outStart);
      if (c.outEnd > 0 && c.outEnd < totalOutDuration) points.add(c.outEnd);
    }
    const sortedPts = Array.from(points).sort((a, b) => a - b);
    const concatLines = [];
    let lastFile = "f_base.jpg";

    for (let i = 0; i < sortedPts.length - 1; i++) {
      const s = sortedPts[i];
      const e = sortedPts[i + 1];
      const dur = e - s;
      if (dur <= 0.005) continue;
      const mid = (s + e) * 0.5;

      let chosen = "f_base.jpg";
      if (blackSegs.some((b) => mid >= b.outStart && mid < b.outEnd)) {
        chosen = "f_black.jpg";
      } else {
        const cue = cueFiles.find((c) => mid >= c.outStart && mid < c.outEnd);
        if (cue) chosen = cue.fname;
      }
      lastFile = chosen;
      concatLines.push(`file '${chosen}'`);
      concatLines.push(`duration ${dur.toFixed(4)}`);
    }
    concatLines.push(`file '${lastFile}'`);

    await f.writeFile("frames.txt", concatLines.join("\n"));

    ffProgressRange = { start: 68, span: 26, label: "MP4動画をエンコード中…" };
    editProgress(68, "MP4動画をエンコード中…");
    await execFF(f, [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", "frames.txt",
      "-i", "mix.wav",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-vf", "fps=2,format=yuv420p",
      "-c:v", "libx264",
      "-tune", "stillimage",
      "-preset", "ultrafast",
      "-rc-lookahead", "0",
      "-refs", "1",
      "-bf", "0",
      "-crf", profile.crf,
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "final.mp4"
    ]);

    editProgress(95, "出力ファイルを生成中…");
    const data = await f.readFile("final.mp4");
    return new Blob([data.buffer], { type: "video/mp4" });
  } catch (err) {
    resetFF();
    throw new Error(formatError(err));
  } finally {
    if (ff && ff.loaded) {
      await cleanupFiles(f, tempFiles);
    }
  }
}

$("execute").onclick = async () => {
  if (!validated && !validate()) return;
  $("execute").disabled = true;
  try {
    editProgress(2, "編集処理を準備中…");
    const format = $("format").value;
    const blob = await render();
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = URL.createObjectURL(blob);

    if (format === "mp4") {
      $("preview").pause();
      $("preview").removeAttribute("src");
      $("preview").hidden = true;
      $("videoPreview").src = outputUrl;
      $("videoPreview").hidden = false;
    } else {
      $("videoPreview").pause();
      $("videoPreview").removeAttribute("src");
      $("videoPreview").hidden = true;
      $("preview").src = outputUrl;
      $("preview").hidden = false;
    }

    $("save").href = outputUrl;
    $("save").download = "podcast_final." + format;
    $("output").hidden = false;
    $("editedDuration").textContent = `${format === "mp4" ? "完成動画" : "完成音源"} · ${(blob.size / 1048576).toFixed(1)} MB`;
    $("compareCard").hidden = false;
    editProgress(100, "編集完了");
    $("output").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    const msg = formatError(e);
    editProgress(0, "エラー", msg);
    alert("編集できませんでした: " + msg);
  } finally {
    updateExecuteButtonState();
  }
};

updateTelopStatus();
updateSkipTranscribeState();
