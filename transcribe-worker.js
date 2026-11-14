import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2";

const MODEL_IDS = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small"
};

let loadedModelKey = null;
let asrPipeline = null;
let loadPromise = null;

function formatMB(bytes) {
  return (bytes / 1048576).toFixed(1) + " MB";
}

function collapseRepetitions(segments) {
  const cleaned = [];
  let prevNorm = "";
  let repeatCount = 0;

  for (const seg of segments) {
    let text = (seg.text || "").trim().replace(/(.{3,25}?){3,}/g, "$1$1");
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
    return asrPipeline;
  }
  if (loadPromise && loadedModelKey === key) {
    return loadPromise;
  }

  loadedModelKey = key;
  asrPipeline = null;
  const modelId = MODEL_IDS[key];
  const fileStats = new Map();
  let compilingNotified = false;

  loadPromise = (async () => {
    env.allowLocalModels = false;
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
    }

    self.postMessage({
      type: "status",
      phase: "model-init",
      percent: 10,
      text: `AIモデル情報を取得中（${modelId}）…`,
      detail: "初回はモデルとWASMエンジンのダウンロードに時間がかかります"
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
          const percent = Math.min(46, 10 + Math.round(ratio * 36));
          const sizeInfo = total > 0 ? ` (${formatMB(loaded)} / ${formatMB(total)})` : "";

          self.postMessage({
            type: "model-progress",
            phase: "downloading",
            percent,
            text: "AIモデルをダウンロード中…",
            detail: `${fileName}${sizeInfo}`
          });
        } else if (p.status === "done" && fileName) {
          const prev = fileStats.get(fileName) || { loaded: 0, total: 0, done: true };
          fileStats.set(fileName, { ...prev, done: true });

          const entries = Array.from(fileStats.entries());
          const hasOnnx = entries.some(([name]) => name.endsWith(".onnx"));
          const allDone = hasOnnx && entries.every(([, v]) => v.done);

          if (allDone && !compilingNotified) {
            compilingNotified = true;
            self.postMessage({
              type: "status",
              phase: "compiling",
              percent: 48,
              text: "ONNX推論エンジンを初期化・コンパイル中…",
              detail: "モデル取得完了。WASMの展開に初回15〜40秒ほどかかります（処理継続中）"
            });
          } else {
            self.postMessage({
              type: "status",
              phase: "downloading",
              percent: 46,
              text: "モデルファイルを展開中…",
              detail: `${fileName} 読み込み完了`
            });
          }
        } else if (p.status === "ready") {
          self.postMessage({
            type: "status",
            phase: "ready",
            percent: 50,
            text: "モデル準備完了。音声の解析を開始します…",
            detail: ""
          });
        }
      }
    });

    asrPipeline = instance;
    return instance;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    asrPipeline = null;
    loadPromise = null;
    loadedModelKey = null;
    throw err;
  }
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type !== "transcribe") return;

  try {
    const asr = await getASR(data.model);
    const audio = new Float32Array(data.audio);
    const sampleRate = 16000;
    const durationSeconds = audio.length / sampleRate;
    const chunkLengthS = 30;
    const strideLengthS = 5;
    const effectiveStepS = chunkLengthS - strideLengthS * 2;
    const estimatedChunks = Math.max(1, Math.ceil(durationSeconds / effectiveStepS));
    let processedChunks = 0;

    self.postMessage({
      type: "status",
      phase: "inferring",
      percent: 50,
      text: `音声を文字起こし中…（約${estimatedChunks}ブロック）`,
      detail: `音声長: ${durationSeconds.toFixed(1)}秒 · 30秒窓 / 5秒オーバーラップ解析`
    });

    const result = await asr(audio, {
      language: data.language || "japanese",
      task: "transcribe",
      chunk_length_s: chunkLengthS,
      stride_length_s: strideLengthS,
      return_timestamps: true,
      repetition_penalty: 1.1,
      no_repeat_ngram_size: 3,
      chunk_callback: () => {
        processedChunks += 1;
        const ratio = Math.min(0.96, processedChunks / estimatedChunks);
        const percent = 50 + Math.round(ratio * 45);
        self.postMessage({
          type: "infer-progress",
          phase: "inferring",
          percent,
          text: `音声を文字起こし中…（${Math.min(processedChunks, estimatedChunks)}/${estimatedChunks} ブロック）`,
          detail: "重なり区間を統合して精度を調整しています"
        });
      }
    });

    self.postMessage({
      type: "status",
      phase: "postprocess",
      percent: 97,
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
    self.postMessage({
      type: "error",
      message: error?.message || String(error)
    });
  }
};
