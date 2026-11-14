import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js";

const $ = (id) => document.getElementById(id);

let source = null;
let segments = [];
let ff = null;
let ffLoadPromise = null;
let validated = null;
let bgm = null;
let sourceDuration = null;
let outputUrl = null;
let sourceUrl = null;
let activeWorker = null;
let elapsedTimer = null;

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
  $("progressbox").hidden = false;
  $("progress").value = p;
  $("progressNum").textContent = `${p}%`;
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
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = URL.createObjectURL(f);
  const audio = new Audio(sourceUrl);
  audio.onloadedmetadata = () => {
    sourceDuration = audio.duration;
    $("sourceDuration").textContent = `音源の長さ：${fmt(sourceDuration)}`;
  };
  $("originalPreview").src = sourceUrl;
  $("compareCard").hidden = false;
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
    activeWorker = new Worker("./transcribe-worker.js?v=0.6.2", { type: "module" });
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
  progress(3, "音声ファイルをデコード中…", "16kHz モノラル形式へ変換しています");
  const mono16k = await decodeAudioTo16kMono(source);
  progress(8, "AIワーカーへ音声データを転送中…", `${(mono16k.byteLength / 1048576).toFixed(1)} MB`);

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
      const loc = err?.filename ? ` (${err.filename}:${err.lineno || 0})` : ""; reject(new Error((err?.message || "Web Worker の読み込みまたは実行に失敗しました。") + loc));
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
    $("transcript").value = segments.map((s) => `[${fmt(s.start)} - ${fmt(s.end)}] ${s.text}`).join("\n");
    $("transcriptCard").hidden = false;
    setActiveStep(2);
    $("transcriptCard").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    progress(0, "エラー", e.message);
    alert("文字起こしに失敗しました: " + e.message);
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
  return `あなたはポッドキャストの編集ディレクターです。以下のタイムスタンプ付き文字起こしを読み、編集指示JSONを作成してください。\n\n方針:\n- 会話の意味を損なわない。発言の途中を切らない。\n- 不要な長い沈黙、明確な言い直し、重複だけを慎重に候補化する。\n- 話題転換には必要に応じてジングルを置く。\n- BGMは会話を邪魔しない音量にする。\n- 不確かな編集は実行せず、notesに理由を書く。\n\n出力は説明文やMarkdown囲みなしのJSONのみ。形式:\n{"version":1,"operations":[{"type":"cut","start":12.5,"end":18.2,"reason":"理由"},{"type":"bgm","start":0,"end":60,"track":"main","volume":0.12,"fade_in":2,"fade_out":3},{"type":"fade","start":58,"end":60,"effect":"out"},{"type":"marker","time":120,"label":"話題転換"}],"notes":["確認事項"]}\n\n利用可能な操作:\n- cut: start/end秒。音源から区間を削除\n- bgm: start/end秒、trackは"main"、volumeは0〜1、fade_in/fade_outは任意の秒数。BGMは指定区間だけ再生し、カットされた区間では元音源時間に沿って進める\n- fade: start/end秒、effectは"in"または"out"。指定範囲で音量をフェード\n- marker: time秒、label文字列（編集目印のみ）\n\n時刻はすべて元音源上の秒数です。音源の長さを超えないでください。カット区間を重複させないでください。\n\n文字起こし:\n${$("transcript").value}`;
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
  if (f) $("instructions").value = await f.text();
};

$("sample").onclick = () => {
  const maxT = sourceDuration && sourceDuration > 10 ? Math.min(45, Math.floor(sourceDuration - 1)) : 45;
  const cutEnd = Math.min(13, maxT);
  const cutStart = Math.min(10, Math.max(0, cutEnd - 2));
  $("instructions").value = JSON.stringify({
    version: 1,
    operations: [
      { type: "cut", start: cutStart, end: cutEnd, reason: "サンプルのカット" },
      { type: "bgm", start: 0, end: maxT, track: "main", volume: 0.1, fade_in: 1, fade_out: 2 },
      { type: "fade", start: Math.max(0, maxT - 2), end: maxT, effect: "out" },
      { type: "marker", time: maxT, label: "話題転換" }
    ],
    notes: ["サンプル指示です。実際の音源に合わせて時刻を修正してください。"]
  }, null, 2);
};

function parseInstructions() {
  const raw = $("instructions").value.trim();
  if (!raw) throw Error("編集指示JSONが入力されていません。");
  // Strip accidental markdown code fences if pasted directly from an LLM
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const obj = JSON.parse(cleaned);
  if (obj.version !== 1 || !Array.isArray(obj.operations)) {
    throw Error("version:1 と operations 配列が必要です。");
  }
  const ops = obj.operations.map((o, i) => {
    if (!o || !["cut", "bgm", "fade", "marker"].includes(o.type)) {
      throw Error(`操作${i + 1}: 未対応typeです`);
    }
    if (o.type === "marker") {
      if (!Number.isFinite(o.time) || o.time < 0) throw Error(`操作${i + 1}: timeが不正です`);
      return o;
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

function validate() {
  try {
    validated = parseInstructions();
    const cuts = validated.operations.filter((o) => o.type === "cut").sort((a, b) => a.start - b.start);
    for (let i = 1; i < cuts.length; i++) {
      if (cuts[i].start < cuts[i - 1].end) throw Error("カット区間が重複しています。");
    }
    if (sourceDuration) {
      for (const o of validated.operations) {
        const end = o.type === "marker" ? o.time : o.end;
        if (end > sourceDuration + 0.05) {
          throw Error(`操作時刻 ${fmt(end)} が音源長 ${fmt(sourceDuration)} を超えています。`);
        }
      }
    }
    $("validation").className = "validation ok";
    $("validation").textContent = `検証OK：${validated.operations.length}件の操作。時刻は元音源基準です。`;
    renderOps();
    renderTimeline();
    $("editCard").hidden = false;
    setActiveStep(3);
    return true;
  } catch (e) {
    validated = null;
    $("validation").className = "validation err";
    $("validation").textContent = "JSONエラー：" + e.message;
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
    s.textContent = o.type === "marker"
      ? `${fmt(o.time)} · ${o.label || ""}`
      : `${fmt(o.start)} – ${fmt(o.end)} · ${o.type === "bgm" ? `音量 ${(o.volume * 100).toFixed(0)}% / IN ${o.fade_in || 0}s / OUT ${o.fade_out || 0}s` : o.reason || o.effect || ""}`;
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
  const duration = sourceDuration || Math.max(1, ...validated.operations.map((o) => (o.type === "marker" ? o.time : o.end)));
  const tracks = [
    { type: "cut", label: "CUT" },
    { type: "bgm", label: "BGM" },
    { type: "fade", label: "FADE" },
    { type: "marker", label: "MARK" }
  ];
  tracks.forEach((t) => {
    const line = document.createElement("div");
    line.className = "timeline-row";
    const name = document.createElement("b");
    name.textContent = t.label;
    const rail = document.createElement("div");
    rail.className = "timeline-rail";
    validated.operations.filter((o) => o.type === t.type).forEach((o) => {
      const el = document.createElement("span");
      el.className = `timeline-event ${t.type}`;
      const start = t.type === "marker" ? o.time : o.start;
      const end = t.type === "marker" ? o.time + duration * 0.006 : o.end;
      el.style.left = `${Math.max(0, (start / duration) * 100)}%`;
      el.style.width = `${Math.max(t.type === "marker" ? 0.8 : 0.5, ((end - start) / duration) * 100)}%`;
      el.title = t.type === "marker" ? `${fmt(o.time)} ${o.label || ""}` : `${fmt(o.start)}-${fmt(o.end)}`;
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
      editProgress(45 + Math.round(ratio * 45), "音声をレンダリング中…", `${Math.round(ratio * 100)}%`);
    });
    const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";
    editProgress(8, "FFmpegコアをダウンロード中…", "初回のみエンジンを取得します");
    const coreURL = await toBlobURL(base + "/ffmpeg-core.js", "text/javascript");
    editProgress(22, "FFmpeg WASMをダウンロード中…", "ffmpeg-core.wasm");
    const wasmURL = await toBlobURL(base + "/ffmpeg-core.wasm", "application/wasm");
    editProgress(35, "FFmpegエンジンを初期化中…", "");
    await instance.load({ coreURL, wasmURL });
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
    throw err;
  }
}

function mapOriginalTime(time, keep) {
  let offset = 0;
  for (const [s, e] of keep) {
    if (time <= s) return offset;
    if (time < e) return offset + time - s;
    offset += e - s;
  }
  return offset;
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
    const end = o.type === "marker" ? o.time : o.end;
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

  const f = await loadFF();
  const ext = (source.name.split(".").pop() || "wav").toLowerCase().replace(/[^a-z0-9]/g, "") || "wav";
  const srcName = `source.${ext}`;
  const format = $("format").value;
  const outName = `final.${format}`;
  const tempFiles = [srcName, outName];
  let bedName = null;

  try {
    editProgress(40, "音声データを編集エンジンへ読み込み中…");
    await f.writeFile(srcName, await fetchFile(source));

    const filters = [];
    const labels = [];
    keep.forEach(([s, e], i) => {
      filters.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
      labels.push(`[a${i}]`);
    });
    filters.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[voice]`);

    const args = ["-i", srcName];
    const bgmOps = ops.filter((o) => o.type === "bgm");
    const bgmPieces = [];

    if (bgmOps.length) {
      if (!bgm) throw Error("BGM指示がありますが、BGMファイルが選択されていません。");
      const bext = (bgm.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp3";
      bedName = `bed.${bext}`;
      tempFiles.push(bedName);
      await f.writeFile(bedName, await fetchFile(bgm));
      args.push("-stream_loop", "-1", "-i", bedName);

      let n = 0;
      for (const op of bgmOps) {
        for (const [ks, ke] of keep) {
          const s = Math.max(op.start, ks);
          const e = Math.min(op.end, ke);
          if (e <= s) continue;
          const outputStart = mapOriginalTime(s, keep);
          const trackOffset = s - op.start;
          const delay = Math.max(0, Math.round(outputStart * 1000));
          const label = `bed${n++}`;
          const pieceDuration = e - s;
          const fadeIn = Math.min(Number(op.fade_in || 0), pieceDuration);
          const fadeOut = Math.min(Number(op.fade_out || 0), pieceDuration);
          let chain = `[1:a]atrim=start=${trackOffset}:duration=${pieceDuration},asetpts=PTS-STARTPTS,volume=${op.volume}`;
          if (fadeIn > 0) chain += `,afade=t=in:st=0:d=${fadeIn}`;
          if (fadeOut > 0) chain += `,afade=t=out:st=${Math.max(0, pieceDuration - fadeOut)}:d=${fadeOut}`;
          filters.push(`${chain},adelay=${delay}|${delay}[${label}]`);
          bgmPieces.push(`[${label}]`);
        }
      }
    }

    let map = "[voice]";
    if (bgmPieces.length) {
      filters.push(`[voice]${bgmPieces.join("")}amix=inputs=${bgmPieces.length + 1}:duration=first:dropout_transition=0:normalize=0[mixed]`);
      map = "[mixed]";
    }

    const fades = ops.filter((o) => o.type === "fade");
    fades.forEach((o, i) => {
      const s = mapOriginalTime(o.start, keep);
      const e = mapOriginalTime(o.end, keep);
      const d = Math.max(0.01, e - s);
      const next = `fade${i}`;
      filters.push(`${map}afade=t=${o.effect}:st=${s}:d=${d}[${next}]`);
      map = `[${next}]`;
    });

    args.push("-filter_complex", filters.join(";"), "-map", map);
    if (format === "mp3") {
      args.push("-c:a", "libmp3lame", "-b:a", "192k", outName);
    } else {
      args.push("-c:a", "pcm_s16le", outName);
    }

    editProgress(45, "音声をレンダリング中…");
    await f.exec(args);
    editProgress(94, "出力ファイルを生成中…");
    const data = await f.readFile(outName);
    return new Blob([data.buffer], { type: format === "mp3" ? "audio/mpeg" : "audio/wav" });
  } finally {
    for (const fileName of tempFiles) {
      try {
        await f.deleteFile(fileName);
      } catch {
        // Ignore cleanup failure if file was not created
      }
    }
  }
}

$("execute").onclick = async () => {
  if (!validated && !validate()) return;
  $("execute").disabled = true;
  try {
    editProgress(2, "編集エンジンを準備中…");
    const blob = await render();
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = URL.createObjectURL(blob);
    $("preview").src = outputUrl;
    $("save").href = outputUrl;
    $("save").download = "podcast_final." + $("format").value;
    $("output").hidden = false;
    $("editedDuration").textContent = `完成音源 · ${(blob.size / 1048576).toFixed(1)} MB`;
    $("compareCard").hidden = false;
    editProgress(100, "編集完了");
    $("output").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    editProgress(0, "エラー", e.message);
    alert("編集できませんでした: " + e.message);
  } finally {
    $("execute").disabled = false;
  }
};
