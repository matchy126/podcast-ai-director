import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2";

const MODEL_IDS = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small"
};

// 20秒分の音声ブロックを処理する初期推定時間（ミリ秒）
const INITIAL_CHUNK_MS = {
  tiny: 3500,
  base: 6000,
  small: 13000
};

let loadedModelKey = null;
let asrPipeline = null;
let loadPromise = null;

function formatMB(bytes) {
  return (bytes / 1048576).toFixed(1) + " MB";
}

function formatSecShort(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}分${r}秒` : `${r}秒`;
}

function formatTimecode(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function collapseRepetitions(segments) {
  const cleaned = [];
  let prevNorm = "";
  let repeatCount = 0;

  for (const seg of segments) {
    let text = (seg.text || "").trim().replace(/(.{3,25}?)\1{3,}/g, "$1$1");
    if (!text) continue;

    const norm = text.replace(/[\s、。！？,.!?]/g, "");
    if (norm && norm === prevNorm) {
      repeatCount += 1;
      if (repeatCount >= 2) {
        continue;
      }
    } else {
      prevNorm = norm;
      repeatCount = 0;
    }
    cleaned.push({ ...seg, text });
  }
  return cleaned;
}

async function getASR(modelKey) {
  const key = MODEL_IDS[modelKey] ? modelKey : "base";
  if (asrPipeline && loadedModelKey === key) {
    return { asr: asrPipeline, wasCachedInMemory: true };
  }
  if (loadPromise && loadedModelKey === key) {
    const asr = await loadPromise;
    return { asr, wasCachedInMemory: false };
  }

  loadedModelKey = key;
  asrPipeline = null;
  const modelId = MODEL_IDS[key];
  const fileStats = new Map();
  let compileTimer = null;

  const stopCompileTimer = () => {
    if (compileTimer) {
      clearInterval(compileTimer);
      compileTimer = null;
    }
  };

  loadPromise = (async () => {
    env.allowLocalModels = false;
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
    }

    self.postMessage({
      type: "status",
      phase: "model-init",
      percent: 6,
      text: `AIモデルを準備中（${modelId}）…`,
      detail: "初回はモデルデータの取得とWASM初期化を行います"
    });

    const instance = await pipeline("automatic-speech-recognition", modelId, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (p) => {
        const fileName = p.file || p.name || "";
        if (p.status === "initiate" && fileName) {
          if (!fileStats.has(fileName)) {
            fileStats.set(fileName, { loaded: 0, total: 0, done: false });
          }
        } else if (p.status === "progress") {
          const prev = fileStats.get(fileName) || { loaded: 0, total: 0, done: false };
          const loaded = Number.isFinite(p.loaded) ? p.loaded : prev.loaded;
          const total = Number.isFinite(p.total) && p.total > 0 ? p.total : prev.total;
          fileStats.set(fileName, { loaded, total, done: false });

          let totalBytes = 0;
          let loadedBytes = 0;
          let pctSum = 0;
          let count = 0;

          for (const item of fileStats.values()) {
            count += 1;
            if (item.total > 0) {
              totalBytes += item.total;
              loadedBytes += item.done ? item.total : Math.min(item.loaded, item.total);
              pctSum += item.done ? 100 : (item.loaded / item.total) * 100;
            } else if (item.done) {
              pctSum += 100;
            }
          }

          const ratio = totalBytes > 0
            ? loadedBytes / totalBytes
            : (count > 0 ? pctSum / (count * 100) : (p.progress || 0) / 100);
          // ダウンロード区間は 6% 〜 20% に割り当て
          const percent = Math.min(20, 6 + ratio * 14);
          const sizeInfo = total > 0 ? ` (${formatMB(loaded)} / ${formatMB(total)})` : "";

          self.postMessage({
            type: "model-progress",
            phase: "downloading",
            percent,
            text: "AIモデルを取得中…",
            detail: `${fileName}${sizeInfo}`
          });
        } else if (p.status === "done" && fileName) {
          const prev = fileStats.get(fileName) || { loaded: 0, total: 0, done: true };
          fileStats.set(fileName, { ...prev, done: true });

          const entries = Array.from(fileStats.entries());
          const hasOnnx = entries.some(([name]) => name.endsWith(".onnx"));
          const allDone = hasOnnx && entries.every(([, v]) => v.done);

          if (allDone && !compileTimer) {
            const compileStart = Date.now();
            self.postMessage({
              type: "status",
              phase: "compiling",
              percent: 20.5,
              text: "推論エンジン（WASM）を初期化中…",
              detail: "初回のみ数秒〜数十秒かかります"
            });
            // コンパイル中も 20.5% 〜 24.8% の範囲で滑らかに進める
            compileTimer = setInterval(() => {
              const sec = (Date.now() - compileStart) / 1000;
              const pct = Math.min(24.8, 20.5 + 4.3 * (1 - Math.exp(-sec / 12)));
              self.postMessage({
                type: "status",
                phase: "compiling",
                percent: pct,
                text: "推論エンジン（WASM）を初期化中…",
                detail: `モデル展開中（${Math.floor(sec)}秒経過）`
              });
            }, 400);
          } else if (!compileTimer) {
            self.postMessage({
              type: "status",
              phase: "downloading",
              percent: 19,
              text: "モデルファイルを展開中…",
              detail: `${fileName} 読み込み完了`
            });
          }
        } else if (p.status === "ready") {
          stopCompileTimer();
          self.postMessage({
            type: "status",
            phase: "ready",
            percent: 25,
            text: "AIモデル準備完了",
            detail: "音声の文字起こし解析へ移行します"
          });
        }
      }
    });

    stopCompileTimer();
    asrPipeline = instance;
    return instance;
  })();

  try {
    const asr = await loadPromise;
    return { asr, wasCachedInMemory: false };
  } catch (err) {
    stopCompileTimer();
    asrPipeline = null;
    loadPromise = null;
    loadedModelKey = null;
    throw err;
  }
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type !== "transcribe") return;

  let smoothTimer = null;
  const stopSmoothTimer = () => {
    if (smoothTimer) {
      clearInterval(smoothTimer);
      smoothTimer = null;
    }
  };

  try {
    const modelKey = MODEL_IDS[data.model] ? data.model : "base";
    const { asr, wasCachedInMemory } = await getASR(modelKey);

    const audio = new Float32Array(data.audio);
    const sampleRate = 16000;
    const durationSeconds = audio.length / sampleRate;
    const chunkLengthS = 30;
    const strideLengthS = 5;
    const effectiveStepS = chunkLengthS - strideLengthS * 2;
    const estimatedChunks = Math.max(1, Math.ceil(durationSeconds / effectiveStepS));

    // メモリ上にモデルロード済みなら 8%〜96%、初回ロード後なら 25%〜96% を推論に割り当て
    const inferStartPct = wasCachedInMemory ? 8 : 25;
    const inferEndPct = 96;
    const inferSpanPct = inferEndPct - inferStartPct;

    let processedChunks = 0;
    const inferStartedAt = Date.now();
    let lastChunkAt = inferStartedAt;
    let avgChunkMs = INITIAL_CHUNK_MS[modelKey] || 6000;
    let lastReportedPct = inferStartPct;

    const emitInferProgress = () => {
      const now = Date.now();
      const sinceLastMs = Math.max(0, now - lastChunkAt);
      // 現在のブロック内の進捗を漸近曲線で滑らかに補間（0〜0.92）
      const intraFraction = processedChunks >= estimatedChunks
        ? 0.95
        : 0.92 * (1 - Math.exp(-2.2 * (sinceLastMs / Math.max(800, avgChunkMs))));

      const effectiveCompleted = Math.min(estimatedChunks - 0.05, processedChunks + intraFraction);
      const rawPct = inferStartPct + (effectiveCompleted / estimatedChunks) * inferSpanPct;
      const pct = Math.min(inferEndPct, Math.max(lastReportedPct, rawPct));
      lastReportedPct = pct;

      const currentBlock = Math.min(estimatedChunks, processedChunks + 1);
      const analyzedSec = Math.min(durationSeconds, effectiveCompleted * effectiveStepS);
      const remainingChunks = Math.max(0, estimatedChunks - effectiveCompleted);
      const etaSec = (remainingChunks * avgChunkMs) / 1000;

      const etaText = etaSec >= 2 ? ` · 残り約 ${formatSecShort(etaSec)}` : " · まもなく完了";
      self.postMessage({
        type: "infer-progress",
        phase: "inferring",
        percent: pct,
        text: `音声を文字起こし中…（ブロック ${currentBlock}/${estimatedChunks}）`,
        detail: `解析進行: ${formatTimecode(analyzedSec)} / ${formatTimecode(durationSeconds)}${etaText}`
      });
    };

    emitInferProgress();
    smoothTimer = setInterval(emitInferProgress, 350);

    const result = await asr(audio, {
      language: data.language || "japanese",
      task: "transcribe",
      chunk_length_s: chunkLengthS,
      stride_length_s: strideLengthS,
      return_timestamps: true,
      repetition_penalty: 1.1,
      no_repeat_ngram_size: 3,
      chunk_callback: () => {
        const now = Date.now();
        processedChunks += 1;
        lastChunkAt = now;
        // 実測された1ブロックあたりの平均処理時間で残り時間予測を自動補正
        const measuredAvg = (now - inferStartedAt) / processedChunks;
        avgChunkMs = measuredAvg * 0.8 + avgChunkMs * 0.2;
        emitInferProgress();
      }
    });

    stopSmoothTimer();

    self.postMessage({
      type: "status",
      phase: "postprocess",
      percent: 98,
      text: "タイムスタンプと文章を整形中…",
      detail: ""
    });

    const rawChunks = Array.isArray(result?.chunks) && result.chunks.length
      ? result.chunks
      : [{ timestamp: [0, durationSeconds], text: result?.text || "" }];

    const rawSegments = rawChunks.map((c, idx) => {
      const start = Math.max(0, Number(c.timestamp?.[0] ?? 0));
      const tsEnd = c.timestamp?.[1];
      let end = Number.isFinite(tsEnd) ? Number(tsEnd) : durationSeconds;
      if (end <= start) {
        const nextStart = rawChunks[idx + 1]?.timestamp?.[0];
        end = Number.isFinite(nextStart) && nextStart > start
          ? Number(nextStart)
          : Math.min(durationSeconds, start + 1.0);
      }
      return {
        start,
        end,
        text: (c.text || "").trim()
      };
    }).filter((s) => s.text);

    const segments = collapseRepetitions(rawSegments);
    self.postMessage({ type: "result", segments });
  } catch (error) {
    stopSmoothTimer();
    self.postMessage({
      type: "error",
      message: error?.message || String(error)
    });
  }
};
