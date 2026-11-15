import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js";

const $ = (id) => document.getElementById(id);

let source = null;
let segments = [];
let ff = null;
let ffLoadPromise = null;
let validated = null;
let bgm = null;
let se = null;
let seDuration = null;
let thumbnail = null;
let thumbnailUrl = null;
let sourceDuration = null;
let outputUrl = null;
let sourceUrl = null;
let activeWorker = null;
let elapsedTimer = null;

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

$("audio").onchange = (e) => setAudio(e.target.files[0]);

function setAudio(f) {
  if (!f) return;
  source = f;
  sourceDuration = null;
  validated = null;
  $("audioName").textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} MB`;
  $("transcribe").disabled = false;
  $("skipTranscribeHint").hidden = false;
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = URL.createObjectURL(f);
  const audio = new Audio(sourceUrl);
  audio.onloadedmetadata = () => {
    sourceDuration = audio.duration;
    $("sourceDuration").textContent = `音源の長さ：${fmt(sourceDuration)}`;
    if ($("instructions").value.trim()) validate();
  };
  $("originalPreview").src = sourceUrl;
  $("compareCard").hidden = false;
  $("transcriptCard").hidden = false;
  $("jsonHeading").classList.toggle("subheading", !$("transcriptArea").hidden);
  $("output").hidden = true;
  setActiveStep(1);
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

$("bgm").onchange = (e) => {
  bgm = e.target.files[0] || null;
  $("bgmName").textContent = bgm ? `選択中：${bgm.name}` : "BGM未選択";
  if (validated) validate();
};

$("se").onchange = async (e) => {
  se = e.target.files[0] || null;
  seDuration = null;
  if (se) {
    try {
      seDuration = await getDuration(se);
      $("seName").textContent = `選択中：${se.name}（${seDuration.toFixed(1)}秒）`;
    } catch {
      $("seName").textContent = `選択中：${se.name}`;
    }
  } else {
    $("seName").textContent = "SE未選択";
  }
  if (validated) validate();
};

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

$("thumbnail").onchange = (e) => {
  thumbnail = e.target.files[0] || null;
  if (thumbnailUrl) {
    URL.revokeObjectURL(thumbnailUrl);
    thumbnailUrl = null;
  }
  if (thumbnail) {
    thumbnailUrl = URL.createObjectURL(thumbnail);
    $("thumbnailPreview").src = thumbnailUrl;
    $("thumbnailPreviewWrap").hidden = false;
    $("thumbnailName").textContent = `選択中：${thumbnail.name}`;
    if ($("format").value !== "mp4") {
      $("format").value = "mp4";
    }
  } else {
    $("thumbnailPreview").removeAttribute("src");
    $("thumbnailPreviewWrap").hidden = true;
    $("thumbnailName").textContent = "サムネイル未選択（MP4出力時は単色背景）";
  }
  updateFormatUi();
  if (validated) validate();
};

async function decodeAudioTo16kMono(file) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("このブラウザはAudioContextに対応していません。");
  }
  const arrayBuffer = await file.arrayBuffer();
  const ctx = new AudioCtx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    await ctx.close().catch(() => {});
  }

  if (!sourceDuration && Number.isFinite(decoded.duration)) {
    sourceDuration = decoded.duration;
    $("sourceDuration").textContent = `音源の長さ：${fmt(sourceDuration)}`;
  }

  const targetRate = 16000;
  const targetLength = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, targetLength, targetRate);
  const srcNode = offline.createBufferSource();
  srcNode.buffer = decoded;
  srcNode.connect(offline.destination);
  srcNode.start(0);
  const rendered = await offline.startRendering();
  const mono = new Float32Array(rendered.getChannelData(0));
  decoded = null;
  return mono;
}

function getWorker() {
  if (!activeWorker) {
    activeWorker = new Worker("./transcribe-worker.js?v=0.6.7", { type: "module" });
  }
  return activeWorker;
}

function resetWorker() {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }
}

async function transcribe() {
  progress(2, "音声ファイルをデコード中…", "16kHz モノラル形式へ変換しています");
  const mono16k = await decodeAudioTo16kMono(source);
  progress(5, "AIワーカーへ音声データを転送中…", `${(mono16k.byteLength / 1048576).toFixed(1)} MB`);

  const worker = getWorker();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
    };

    worker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === "status" || msg.type === "model-progress" || msg.type === "infer-progress") {
        const pct = Number.isFinite(msg.percent) ? msg.percent : Number($("progress").value || 10);
        progress(pct, msg.text || "処理中…", msg.detail || "");
      } else if (msg.type === "result") {
        cleanup();
        progress(100, "文字起こし完了", `${msg.segments?.length || 0} セグメント抽出`);
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
        audio: mono16k.buffer,
        model: $("model").value,
        language: $("language").value
      },
      [mono16k.buffer]
    );
  });
}

$("cancelTranscribe").onclick = () => {
  resetWorker();
  stopElapsedTimer();
  $("cancelTranscribe").hidden = true;
  $("transcribe").disabled = !source;
  progress(0, "中止しました", "必要に応じて再実行できます");
};

$("transcribe").onclick = async () => {
  if (!source) return;
  $("transcribe").disabled = true;
  $("cancelTranscribe").hidden = false;
  $("progressTimer").textContent = "";
  startElapsedTimer();

  try {
    progress(2, "文字起こしを準備中…");
    segments = await transcribe();
    $("transcript").value = segments.map((s) => `[${fmt(s.start)} - ${fmt(s.end)}] ${s.text}`).join("
");
    $("transcriptCard").hidden = false;
    $("transcriptArea").hidden = false;
    $("jsonHeading").classList.add("subheading");
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
  return `あなたはポッドキャストの編集ディレクターです。以下のタイムスタンプ付き文字起こしを読み、編集指示JSONを作成してください。

方針:
- 会話の意味を損なわない。発言の途中を切らない。
- 不要な長い沈黙、明確な言い直し、重複だけを慎重に候補化する。
- 場面切り替えや話題転換には se（mode:"insert" で割り込み挿入）または marker を置く。
- BGMは会話を邪魔しない音量にする。
- フェード（fade）は本編の最初と最後のみに適用する。
- 不確かな編集は実行せず、notesに理由を書く。

出力は説明文やMarkdown囲みなしのJSONのみ。形式:
{"version":1,"skip_transcription_if_exists":true,"operations":[{"type":"cut","start":12.5,"end":18.2,"reason":"理由"},{"type":"bgm","start":0,"end":60,"track":"main","volume":0.08,"fade_in":2,"fade_out":3},{"type":"se","time":60,"mode":"insert","duration":1.0,"visual":"black","volume":0.7,"label":"場面切り替え"},{"type":"fade","start":0,"end":1.5,"effect":"in"},{"type":"fade","start":58,"end":60,"effect":"out"},{"type":"marker","time":120,"label":"話題転換"}],"notes":["確認事項"]}

利用可能な操作:
- cut: start/end秒。音源から区間を削除
- bgm: start/end秒、trackは"main"、volumeは0〜1、fade_in/fade_outは任意の秒数
- se: time秒、modeは"insert"（シーン境界に挿入し後ろの音声を押し出す）または"overlay"（重ねて再生）、durationは挿入秒数、visualは"black"（MP4時黒画面）、volumeは0〜1（省略時0.8）、label文字列
- fade: start/end秒、effectは"in"または"out"
- marker: time秒、label文字列

時刻はすべて元音源上の秒数です。音源の長さを超えないでください。カット区間を重複させないでください。

文字起こし:
${$("transcript").value}`;
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

$("jsonFile").onchange = async (e) => {
  const f = e.target.files[0];
  if (f) {
    $("instructions").value = await f.text();
    validate();
  }
};

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
  const obj = JSON.parse(cleaned);
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

    const hasBgm = validated.operations.some((o) => o.type === "bgm");
    if (hasBgm && !bgm) notes.push("BGM指示あり：STEP 04でBGMファイルを選択してください");

    if (effectiveSe.length > 0 && !se) {
      notes.push("SE指示あり：STEP 04で場面切り替えSEファイルを選択してください");
    }

    if ($("format").value === "mp4" && !thumbnail) {
      notes.push("MP4出力：サムネイル未選択のため単色背景で生成します");
    }

    const suffix = notes.length ? `（${notes.join(" / ")}）` : "";
    $("validation").className = "validation ok";
    $("validation").textContent = `検証OK：${validated.operations.length}件の操作。時刻は元音源基準です。${suffix}`;
    renderOps();
    renderTimeline();
    $("editCard").hidden = false;
    setActiveStep(3);
    return true;
  } catch (e) {
    validated = null;
    $("validation").className = "validation err";
    $("validation").textContent = "JSONエラー：" + formatError(e);
    $("editCard").hidden = true;
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

async function loadFF() {
  if (ff && ff.loaded) return ff;
  if (ffLoadPromise) return ffLoadPromise;

  ffLoadPromise = (async () => {
    const instance = new FFmpeg();
    instance.on("progress", ({ progress: p }) => {
      const ratio = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
      editProgress(45 + Math.round(ratio * 45), "メディアをレンダリング中…", `${Math.round(ratio * 100)}%`);
    });
    const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
    const workerCode = 'import "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/worker.js";';
    const classWorkerURL = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
    editProgress(8, "FFmpegコアをダウンロード中…", "初回のみエンジンを取得します");
    const coreURL = await toBlobURL(base + "/ffmpeg-core.js", "text/javascript");
    editProgress(22, "FFmpeg WASMをダウンロード中…", "ffmpeg-core.wasm");
    const wasmURL = await toBlobURL(base + "/ffmpeg-core.wasm", "application/wasm");
    editProgress(35, "FFmpegエンジンを初期化中…", "");
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
    ff = null;
    ffLoadPromise = null;
    throw new Error(formatError(err));
  }
}

function buildTimelineSegments(keep, insertEvents) {
  const sortedInserts = [...insertEvents].sort((a, b) => a.time - b.time);
  const usedInsertIndices = new Set();
  const timeline = [];
  let outCursor = 0;

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

  return { timeline, totalOutDuration: outCursor };
}

function mapOriginalToOutput(origTime, timeline, totalOutDuration) {
  for (const seg of timeline) {
    if (seg.kind === "source") {
      if (origTime <= seg.origStart) return seg.outStart;
      if (origTime < seg.origEnd) return seg.outStart + (origTime - seg.origStart);
    } else if (seg.kind === "insert") {
      if (origTime <= seg.origTime) return seg.outEnd;
    }
  }
  return totalOutDuration;
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

async function render() {
  if (!source) throw Error("元音源ファイルが選択されていません。");
  const obj = validated || parseInstructions();
  const duration = sourceDuration || (await getDuration(source));
  const ops = obj.operations.filter((o) => o.type !== "marker");

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
  if (bgmOps.length && !bgm) {
    throw Error("BGM指示がありますが、BGMファイルが選択されていません。");
  }

  const allSeEvents = getEffectiveSeEvents(obj.operations);
  if (allSeEvents.length > 0 && !se) {
    throw Error("SE指示がありますが、場面切り替えSEファイルが選択されていません。");
  }

  const insertSeEvents = se ? allSeEvents.filter((ev) => ev.mode === "insert") : [];
  const overlaySeEvents = se ? allSeEvents.filter((ev) => ev.mode !== "insert") : [];
  const { timeline, totalOutDuration } = buildTimelineSegments(keep, insertSeEvents);

  const f = await loadFF();
  const ext = (source.name.split(".").pop() || "wav").toLowerCase().replace(/[^a-z0-9]/g, "") || "wav";
  const srcName = `source.${ext}`;
  const format = $("format").value;
  const outName = `final.${format}`;
  const tempFiles = [srcName, outName];

  try {
    editProgress(40, "素材データを編集エンジンへ読み込み中…");
    await f.writeFile(srcName, await fetchFile(source));

    const filters = [];
    const labels = [];
    timeline.forEach((seg, i) => {
      if (seg.kind === "source") {
        filters.push(
          `[0:a]atrim=start=${seg.origStart}:end=${seg.origEnd},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`
        );
      } else {
        const dur = Math.max(0.05, seg.outEnd - seg.outStart);
        filters.push(
          `anullsrc=r=44100:cl=stereo,atrim=duration=${dur},asetpts=PTS-STARTPTS[a${i}]`
        );
      }
      labels.push(`[a${i}]`);
    });
    filters.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[voice]`);

    const args = ["-i", srcName];
    let nextInputIdx = 1;
    const mixInputs = [];

    if (bgmOps.length) {
      const bext = (bgm.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp3";
      const bedName = `bed.${bext}`;
      tempFiles.push(bedName);
      await f.writeFile(bedName, await fetchFile(bgm));
      const bgmInputIdx = nextInputIdx++;
      args.push("-stream_loop", "-1", "-i", bedName);

      let n = 0;
      for (const op of bgmOps) {
        for (const seg of timeline) {
          if (seg.kind !== "source") continue;
          const s = Math.max(op.start, seg.origStart);
          const e = Math.min(op.end, seg.origEnd);
          if (e <= s) continue;
          const outputStart = seg.outStart + (s - seg.origStart);
          const trackOffset = s - op.start;
          const delay = Math.max(0, Math.round(outputStart * 1000));
          const label = `bed${n++}`;
          const pieceDuration = e - s;
          const fadeIn = Math.min(Number(op.fade_in || 0), pieceDuration);
          const fadeOut = Math.min(Number(op.fade_out || 0), pieceDuration);
          let chain = `[${bgmInputIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=start=${trackOffset}:duration=${pieceDuration},asetpts=PTS-STARTPTS,volume=${op.volume}`;
          if (fadeIn > 0 && Math.abs(s - op.start) < 0.05) chain += `,afade=t=in:st=0:d=${fadeIn}`;
          if (fadeOut > 0 && Math.abs(e - op.end) < 0.05) chain += `,afade=t=out:st=${Math.max(0, pieceDuration - fadeOut)}:d=${fadeOut}`;
          filters.push(`${chain},adelay=${delay}|${delay}[${label}]`);
          mixInputs.push(`[${label}]`);
        }
      }
    }

    if (se && (insertSeEvents.length || overlaySeEvents.length)) {
      const sext = (se.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp3";
      const seName = `se.${sext}`;
      tempFiles.push(seName);
      await f.writeFile(seName, await fetchFile(se));
      const seInputIdx = nextInputIdx++;
      args.push("-i", seName);

      let sfxIdx = 0;
      for (const seg of timeline) {
        if (seg.kind !== "insert") continue;
        const delay = Math.max(0, Math.round(seg.outStart * 1000));
        const dur = Math.max(0.05, seg.outEnd - seg.outStart);
        const label = `sfx${sfxIdx++}`;
        filters.push(
          `[${seInputIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=0:${dur},asetpts=PTS-STARTPTS,volume=${seg.seEvent.volume},adelay=${delay}|${delay}[${label}]`
        );
        mixInputs.push(`[${label}]`);
      }

      for (const ev of overlaySeEvents) {
        const outputStart = mapOriginalToOutput(ev.time, timeline, totalOutDuration);
        const delay = Math.max(0, Math.round(outputStart * 1000));
        const label = `sfx${sfxIdx++}`;
        filters.push(
          `[${seInputIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=${ev.volume},adelay=${delay}|${delay}[${label}]`
        );
        mixInputs.push(`[${label}]`);
      }
    }

    let map = "[voice]";
    if (mixInputs.length) {
      filters.push(`[voice]${mixInputs.join("")}amix=inputs=${mixInputs.length + 1}:duration=first:dropout_transition=0:normalize=0[mixed]`);
      map = "[mixed]";
    }

    const fades = ops.filter((o) => o.type === "fade");
    fades.forEach((o, i) => {
      const d = Math.max(0.01, o.end - o.start);
      const st = o.effect === "out"
        ? Math.max(0, totalOutDuration - d)
        : mapOriginalToOutput(o.start, timeline, totalOutDuration);
      const next = `fade${i}`;
      filters.push(`${map}afade=t=${o.effect}:st=${st}:d=${d}[${next}]`);
      map = `[${next}]`;
    });

    let thumbInputIdx = null;
    if (format === "mp4") {
      thumbInputIdx = nextInputIdx++;
      if (thumbnail) {
        const text = (thumbnail.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
        const thumbName = `thumb.${text}`;
        tempFiles.push(thumbName);
        await f.writeFile(thumbName, await fetchFile(thumbnail));
        args.push("-loop", "1", "-framerate", "1", "-i", thumbName);
      } else {
        args.push("-f", "lavfi", "-i", "color=c=0x0b1120:s=1280x720:r=1");
      }
    }

    args.push("-filter_complex", filters.join(";"));

    if (format === "mp4") {
      const blackWindows = timeline
        .filter((seg) => seg.kind === "insert" && seg.seEvent?.visual === "black")
        .map((seg) => `between(t,${seg.outStart.toFixed(3)},${seg.outEnd.toFixed(3)})`);
      let vf = "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p";
      if (blackWindows.length) {
        vf += `,drawbox=c=black:t=fill:enable='${blackWindows.join("+")}'`;
      }
      args.push(
        "-map", `${thumbInputIdx}:v`,
        "-map", map,
        "-c:v", "libx264",
        "-tune", "stillimage",
        "-preset", "ultrafast",
        "-crf", "23",
        "-vf", vf,
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "-movflags", "+faststart",
        outName
      );
    } else if (format === "mp3") {
      args.push("-map", map, "-c:a", "libmp3lame", "-b:a", "192k", outName);
    } else {
      args.push("-map", map, "-c:a", "pcm_s16le", outName);
    }

    editProgress(45, format === "mp4" ? "MP4動画をエンコード中…" : "音声をレンダリング中…");
    await f.exec(args);
    editProgress(94, "出力ファイルを生成中…");
    const data = await f.readFile(outName);
    const mime = format === "mp4" ? "video/mp4" : format === "mp3" ? "audio/mpeg" : "audio/wav";
    return new Blob([data.buffer], { type: mime });
  } catch (err) {
    throw new Error(formatError(err));
  } finally {
    for (const fileName of tempFiles) {
      try {
        await f.deleteFile(fileName);
      } catch {
        // Ignore cleanup failure
      }
    }
  }
}

$("execute").onclick = async () => {
  if (!validated && !validate()) return;
  $("execute").disabled = true;
  try {
    editProgress(2, "編集エンジンを準備中…");
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
    $("execute").disabled = false;
  }
};
