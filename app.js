import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2";
import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js";

const $ = id => document.getElementById(id);
let source = null, segments = [], ff = null, validated = null, bgm = null, sourceDuration = null, outputUrl = null, sourceUrl = null;
const fmt = s => { const m = Math.floor(s / 60), x = (s % 60).toFixed(1).padStart(4, "0"); return `${String(m).padStart(2, "0")}:${x}`; };
function progress(p, t, d = "") { $("progressbox").hidden = false; $("progress").value = p; $("progressNum").textContent = p + "%"; $("progressText").textContent = t; $("progressDetail").textContent = d; }
function editProgress(p, t) { $("editProgressBox").hidden = false; $("editProgress").value = p; $("editProgressNum").textContent = p + "%"; $("editProgressText").textContent = t; }

$("audio").onchange = e => setAudio(e.target.files[0]);
function setAudio(f) {
  if (!f) return;
  source = f; sourceDuration = null; validated = null;
  $("audioName").textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} MB`;
  $("transcribe").disabled = false;
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = URL.createObjectURL(f);
  const audio = new Audio(sourceUrl);
  audio.onloadedmetadata = () => { sourceDuration = audio.duration; $("sourceDuration").textContent = `音源の長さ：${fmt(sourceDuration)}`; };
  $("originalPreview").src = sourceUrl;
  $("compareCard").hidden = false;
  $("output").hidden = true;
}
$("drop").ondragover = e => e.preventDefault();
$("drop").ondrop = e => { e.preventDefault(); setAudio(e.dataTransfer.files[0]); };
$("bgm").onchange = e => { bgm = e.target.files[0] || null; $("bgmName").textContent = bgm ? `選択中：${bgm.name}` : "BGM未選択"; };

async function transcribe() {
  const models = { tiny: "onnx-community/whisper-tiny", base: "onnx-community/whisper-base", small: "onnx-community/whisper-small" };
  env.allowLocalModels = false;
  const asr = await pipeline("automatic-speech-recognition", models[$("model").value], { dtype: "q8", progress_callback: p => { if (p.status === "progress") progress(5 + Math.round((p.progress || 0) * .45), "AIモデルをダウンロード中…", p.file || ""); } });
  const url = URL.createObjectURL(source);
  try {
    const r = await asr(url, { language: $("language").value, task: "transcribe", chunk_length_s: 25, stride_length_s: 5, return_timestamps: true });
    return (r.chunks || [{ timestamp: [0, null], text: r.text }]).map(c => ({ start: Number(c.timestamp?.[0] || 0), end: Number(c.timestamp?.[1] || 0), text: (c.text || "").trim() })).filter(x => x.text);
  } finally { URL.revokeObjectURL(url); }
}
$("transcribe").onclick = async () => {
  $("transcribe").disabled = true;
  try { progress(2, "文字起こしを準備中…"); segments = await transcribe(); $("transcript").value = segments.map(s => `[${fmt(s.start)} - ${fmt(s.end)}] ${s.text}`).join("
"); $("transcriptCard").hidden = false; $("transcriptCard").scrollIntoView({ behavior: "smooth" }); }
  catch (e) { alert("文字起こしに失敗しました: " + e.message); progress(0, "ラー", e.message); }
  finally { $("transcribe").disabled = false; }
};
function transcriptObject() { return { version: 1, language: $("language").value, source_file: source?.name, segments }; }
function promptText() {
  return `あなたはポッドキャストの編集ディレクターです。以下のタイムスタンプ付き文字起こしを読み、編集指示JSONを作成してください。

方針:
- 会話の意味を損なわない。発言の途中を切らない。
- 不要な長い沈黙、明確な言い直し、重複だけを慎重に候補化する。
- 話題転換には必要に応じてジングルを置く。
- BGMは会話を邪魔しない音量にする。
- 不確かな編集は実行せず、notesに理由を書く。

出力は説明文やMarkdown囲みなしのJSONのみ。形式:
{"version":1,"operations":[{"type":"cut","start":12.5,"end":18.2,"reason":"理由"},{"type":"bgm","start":0,"end":60,"track":"main","volume":0.12,"fade_in":2,"fade_out":3},{"type":"fade","start":58,"end":60,"effect":"out"},{"type":"marker","time":120,"label":"話題転換"}],"notes":["確認事項"]}

利用可能な操作:
- cut: start/end秒。音源から区間を削除
- bgm: start/end秒、trackは"main"、volumeは0〜1、fade_in/fade_outは任意の秒数。BGMは指定区間だけ再生し、カットされた区間では元音源時間に沿って進める
- fade: start/end秒、effectは"in"または"out"。指定範囲で音量をフェード
- marker: time秒、label文字列（編集目印のみ）

時刻はすべて元音源上の秒数です。音源の長さを超えないでください。カット区間を重複させないでください。

文字起こし:
${$("transcript").value}`;
}
$("copyPrompt").onclick = async () => { try { await navigator.clipboard.writeText(promptText()); $("copyPrompt").textContent = "コピーしました"; } catch { $("transcript").value = promptText(); alert("コピーできないため、文字起こし欄に依頼文を表示しました。"); } };
function dl(text, name, type) { const u = URL.createObjectURL(new Blob([text], { type })), a = document.createElement("a"); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); }
$("downloadTranscript").onclick = () => dl($("transcript").value, "transcript.txt", "text/plain;charset=utf-8");
$("downloadTranscriptJson").onclick = () => dl(JSON.stringify(transcriptObject(), null, 2), "transcript.json", "application/json");
$("jsonFile").onchange = async e => { const f = e.target.files[0]; if (f) $("instructions").value = await f.text(); };
$("sample").onclick = () => { $("instructions").value = JSON.stringify({ version: 1, operations: [{ type: "cut", start: 10, end: 13, reason: "サンプルのカット" }, { type: "bgm", start: 0, end: 45, track: "main", volume: 0.1 }, { type: "fade", start: 43, end: 45, effect: "out" }, { type: "marker", time: 45, label: "話題転換" }], notes: ["サンプル指示です。実際の音源に合わせて刻を修正してください。"] }, null, 2); };

function parseInstructions() {
  const obj = JSON.parse($("instructions").value);
  if (obj.version !== 1 || !Array.isArray(obj.operations)) throw Error("version:1 と operations 配列が必要です。");
  const ops = obj.operations.map((o, i) => {
    if (!o || !["cut", "bgm", "fade", "marker"].includes(o.type)) throw Error(`操作${i + 1}: 未対応typeです`);
    if (o.type === "marker") { if (!Number.isFinite(o.time) || o.time < 0) throw Error(`操作${i + 1}: timeが不正です`); return o; }
    if (!Number.isFinite(o.start) || !Number.isFinite(o.end) || o.start < 0 || o.end <= o.start) throw Error(`操作${i + 1}: start/endが不正です`);
    if (o.type === "bgm" && (!Number.isFinite(o.volume) || o.volume < 0 || o.volume > 1 || (o.track && o.track !== "main"))) throw Error(`操作${i + 1}: BGMのtrackまたはvolumeが不正です`);
    if (o.type === "bgm" && ((o.fade_in != null && (!Number.isFinite(o.fade_in) || o.fade_in < 0)) || (o.fade_out != null && (!Number.isFinite(o.fade_out) || o.fade_out < 0)))) throw Error(`操作${i + 1}: fade_in/fade_outは0以上の秒数です`);
    if (o.type === "fade" && !["in", "out"].includes(o.effect)) throw Error(`操作${i + 1}: effectはin/outです`);
    return o;
  });
  return { ...obj, operations: ops };
}
function validate() {
  try {
    validated = parseInstructions();
    const cuts = validated.operations.filter(o => o.type === "cut").sort((a, b) => a.start - b.start);
    for (let i = 1; i < cuts.length; i++) if (cuts[i].start < cuts[i - 1].end) throw Error("カット区間が重複しています。");
    if (sourceDuration) for (const o of validated.operations) { const end = o.type === "marker" ? o.time : o.end; if (end > sourceDuration + .05) throw Error(`操作時刻 ${fmt(end)} が音源長 ${fmt(sourceDuration)} を超えています。`); }
    $("validation").className = "validation ok"; $("validation").textContent = `検証OK：${validated.operations.length}件の操作。時刻は元音源基準です。`; renderOps(); renderTimeline(); $("editCard").hidden = false; return true;
  } catch (e) { validated = null; $("validation").className = "validation err"; $("validation").textContent = "JSONエラー：" + e.message; $("editCard").hidden = true; return false; }
}
$("validate").onclick = validate;
function renderOps() {
  const el = $("operationList"); el.innerHTML = "";
  validated.operations.forEach(o => {
    const d = document.createElement("div"); d.className = "op";
    const b = document.createElement("b"); b.textContent = o.type.toUpperCase();
    const s = document.createElement("span");
    s.textContent = o.type === "marker" ? `${fmt(o.time)} · ${o.label || ""}` : `${fmt(o.start)} – ${fmt(o.end)} · ${o.type === "bgm" ? `音量 ${(o.volume * 100).toFixed(0)}% / IN ${o.fade_in || 0}s / OUT ${o.fade_out || 0}s` : o.reason || o.effect || ""}`;
    d.append(b, s); el.append(d);
  });
}
function seekOriginal(seconds) { const player = $("originalPreview"); if (!player.src) return; player.currentTime = Math.max(0, seconds); player.play().catch(() => {}); }
function renderTimeline() {
  const root = $("timeline"); root.innerHTML = "";
  const duration = sourceDuration || Math.max(1, ...validated.operations.map(o => o.type === "marker" ? o.time : o.end));
  const tracks = [{ type: "cut", label: "CUT" }, { type: "bgm", label: "BGM" }, { type: "fade", label: "FADE" }, { type: "marker", label: "MARK" }];
  tracks.forEach(t => {
    const line = document.createElement("div"); line.className = "timeline-row";
    const name = document.createElement("b"); name.textContent = t.label;
    const rail = document.createElement("div"); rail.className = "timeline-rail";
    validated.operations.filter(o => o.type === t.type).forEach(o => {
      const el = document.createElement("span"); el.className = `timeline-event ${t.type}`;
      const start = t.type === "marker" ? o.time : o.start, end = t.type === "marker" ? o.time + duration * .006 : o.end;
      el.style.left = `${Math.max(0, start / duration * 100)}%`; el.style.width = `${Math.max(t.type === "marker" ? .8 : .5, (end - start) / duration * 100)}%`;
      el.title = t.type === "marker" ? `${fmt(o.time)} ${o.label || ""}` : `${fmt(o.start)}-${fmt(o.end)}`;
      el.tabIndex = 0; el.setAttribute("role", "button"); el.setAttribute("aria-label", `元音源 ${fmt(start)} に移動`);
      el.addEventListener("click", ev => { ev.stopPropagation(); seekOriginal(start); });
      el.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); seekOriginal(start); } });
      rail.append(el);
    });
    rail.title = "クリックした位置の元音源を再生します"; rail.addEventListener("click", ev => { const rect = rail.getBoundingClientRect(); const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)); seekOriginal(ratio * duration); });
    line.append(name, rail); root.append(line);
  });
  $("timelineScale").textContent = `00:00　　　　　　　　　　　　　　　　　${fmt(duration / 2)}　　　　　　　　　　　　　　　　　${fmt(duration)}`;
}
let ffLoadPromise = null;
async function loadFF() {
  if (ff && ff.loaded) return ff;
  if (ffLoadPromise) return ffLoadPromise;
  ffLoadPromise = (async () => {
    const candidate = new FFmpeg();
    candidate.on("progress", ({ progress }) => { editProgress(45 + Math.round((progress || 0) * 45), "音声をレンダリング中…"); });
    candidate.on("log", ({ message }) => { candidate.lastLog = message; });
    const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";
    try {
      editProgress(8, "FFmpeg本体をダウンロード中…");
      const [coreURL, wasmURL] = await Promise.all([ toBlobURL(base + "/ffmpeg-core.js", "text/javascript"), toBlobURL(base + "/ffmpeg-core.wasm", "application/wasm") ]);
      editProgress(25, "FFmpegを初期化中…");
      await candidate.load({ coreURL, wasmURL });
      if (!candidate.loaded) throw new Error("FFmpegの初期化完了を確認できませんでした。");
      ff = candidate; return candidate;
    } catch (error) {
      try { candidate.terminate(); } catch {}
      ff = null; const detail = error?.message || String(error);
      throw new Error("FFmpegの読み込みに失敗しました。ページを再読み込みして再試行してください。詳細: " + detail);
    }
  })();
  try { return await ffLoadPromise; } finally { ffLoadPromise = null; }
}
function mapOriginalTime(time, keep) {
  let offset = 0;
  for (const [s, e] of keep) { if (time <= s) return offset; if (time < e) return offset + time - s; offset += e - s; }
  return offset;
}
async function getDuration(file) {
  return new Promise((resolve, reject) => { const u = URL.createObjectURL(file), a = new Audio(); a.onloadedmetadata = () => { URL.revokeObjectURL(u); resolve(a.duration); }; a.onerror = () => { URL.revokeObjectURL(u); reject(Error("音源の長さを読み取れません。")); }; a.src = u; });
}
async function render() {
  const obj = validated || parseInstructions(), duration = sourceDuration || await getDuration(source);
  const ops = obj.operations.filter(o => o.type !== "marker");
  for (const o of obj.operations) { const end = o.type === "marker" ? o.time : o.end; if (end > duration + .05) throw Error(`編集時刻 ${end.toFixed(1)}秒が音源長 ${duration.toFixed(1)}秒を超えています。`); }
  const cuts = ops.filter(o => o.type === "cut").sort((a, b) => a.start - b.start);
  for (let i = 1; i < cuts.length; i++) if (cuts[i].start < cuts[i - 1].end) throw Error("カット区間が重複しています。");
  const keep = []; let cur = 0;
  cuts.forEach(c => { if (c.start > cur) keep.push([cur, c.start]); cur = c.end; }); if (cur < duration) keep.push([cur, duration]);
  if (!keep.length) throw Error("音声全体がカットされています。");
  const f = await loadFF();
  const ext = (source.name.split(".").pop() || "wav").toLowerCase().replace(/[^a-z0-9]/g, "");
  await f.writeFile("source." + ext, await fetchFile(source));
  const filters = [], labels = [];
  keep.forEach(([s, e], i) => { filters.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`); labels.push(`[a${i}]`); });
  filters.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[voice]`);
  const args = ["-i", "source." + ext];
  const bgmOps = ops.filter(o => o.type === "bgm");
  const bgmPieces = [];
  if (bgmOps.length) {
    if (!bgm) throw Error("BGM指示がありますが、BGMファイルが選択されていません。");
    const bext = (bgm.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "");
    await f.writeFile("bed." + bext, await fetchFile(bgm)); args.push("-stream_loop", "-1", "-i", "bed." + bext);
    let n = 0;
    for (const op of bgmOps) {
      for (const [ks, ke] of keep) {
        const s = Math.max(op.start, ks), e = Math.min(op.end, ke);
        if (e <= s) continue;
        const outputStart = mapOriginalTime(s, keep), trackOffset = s - op.start, delay = Math.max(0, Math.round(outputStart * 1000));
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
  if (bgmPieces.length) { filters.push(`[voice]${bgmPieces.join("")}amix=inputs=${bgmPieces.length + 1}:duration=first:dropout_transition=0:normalize=0[mixed]`); map = "[mixed]"; }
  const fades = ops.filter(o => o.type === "fade");
  fades.forEach((o, i) => { const s = mapOriginalTime(o.start, keep), e = mapOriginalTime(o.end, keep), d = Math.max(.01, e - s), next = `fade${i}`; filters.push(`${map}afade=t=${o.effect}:st=${s}:d=${d}[${next}]`); map = `[${next}]`; });
  const format = $("format").value, out = "final." + format;
  args.push("-filter_complex", filters.join(";"), "-map", map);
  if (format === "mp3") args.push("-c:a", "libmp3lame", "-b:a", "192k", out); else args.push("-c:a", "pcm_s16le", out);
  await f.exec(args); const data = await f.readFile(out); return new Blob([data.buffer], { type: format === "mp3" ? "audio/mpeg" : "audio/wav" });
}
$("execute").onclick = async () => {
  if (!validated && !validate()) return;
  $("execute").disabled = true;
  try {
    editProgress(2, "編集エンジンを準備中…"); const blob = await render();
    if (outputUrl) URL.revokeObjectURL(outputUrl); outputUrl = URL.createObjectURL(blob);
    $("preview").src = outputUrl; $("save").href = outputUrl; $("save").download = "podcast_final." + $("format").value;
    $("output").hidden = false; $("editedDuration").textContent = `完成音源 · ${(blob.size / 1048576).toFixed(1)} MB`;
    $("compareCard").hidden = false; editProgress(100, "編集完了"); $("output").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    editProgress(0, "編集できませんでした: " + (e?.message || String(e)));
    let errorBox = $("editError");
    if (!errorBox) { errorBox = document.createElement("pre"); errorBox.id = "editError"; errorBox.className = "validation err"; $("editProgressBox").after(errorBox); }
    errorBox.textContent = e?.stack || e?.message || String(e);
  }
  finally { $("execute").disabled = false; }
};
