import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2";

const MODEL_IDS = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small"
};

const INITIAL_CHUNK_MS = {
  wasm: { tiny: 3000, base: 5200, small: 11000 },
  webgpu: { tiny: 450, base: 750, small: 1500 }
};

let loadedKey = null; // `${modelKey}:${device}`
let asrPipeline = null;
let loadPromise = null;
let activeDeviceUsed = "wasm";

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

async function canUseWebGPU() {
  try {
    if (typeof navigator === "undefined" || !navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

/**
 * 適応型VAD（無音区間スキップ）：
 * 長い沈黙を除外して発話区間のみを連結し、元のタイムスタンプへ逆変換できるようにする
 */
function extractSpeechRegions(audio, sampleRate = 16000) {
  const totalSamples = audio.length;
  const totalSec = totalSamples / sampleRate;
  if (totalSec < 12) return null;

  const frameLen = Math.floor(sampleRate * 0.1); // 100ms
  const numFrames = Math.floor(totalSamples / frameLen);
  if (numFrames < 30) return null;

  const rmsArr = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    let sumSq = 0;
    const base = i * frameLen;
    for (let j = 0; j < frameLen; j += 2) {
      const v = audio[base + j];
      sumSq += v * v;
    }
    rmsArr[i] = Math.sqrt(sumSq / (frameLen / 2));
  }

  const sorted = Array.from(rmsArr).sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(numFrames * 0.15)] || 0;
  const threshold = Math.max(0.005, Math.min(0.028, noiseFloor * 2.5));

  const padFrames = 4;      // 前後 0.4秒の余白を保持
  const minGapFrames = 18;  // 1.8秒以上の無音のみカット

  const rawIntervals = [];
  let inSeg = false;
  let startF = 0;

  for (let i = 0; i < numFrames; i++) {
    const sp = rmsArr[i] > threshold;
    if (sp && !inSeg) {
      inSeg = true;
      startF = Math.max(0, i - padFrames);
    } else if (!sp && inSeg) {
      inSeg = false;
      rawIntervals.push([startF, Math.min(numFrames, i + padFrames)]);
    }
  }
  if (inSeg) {
    rawIntervals.push([startF, numFrames]);
  }
  if (!rawIntervals.length) return null;

  const merged = [rawIntervals[0]];
  for (let i = 1; i < rawIntervals.length; i++) {
    const [s, e] = rawIntervals[i];
    if (s - merged[merged.length - 1][1] < minGapFrames) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }

  let packedSamples = 0;
  const ranges = [];
  for (const [sF, eF] of merged) {
    const origStartSample = sF * frameLen;
    const origEndSample = Math.min(totalSamples, eF * frameLen);
    const len = origEndSample - origStartSample;
    if (len <= sampleRate * 0.1) continue;

    ranges.push({
      origStartSample,
      origEndSample,
      origStart: origStartSample / sampleRate,
      origEnd: origEndSample / sampleRate,
      packedStart: packedSamples / sampleRate,
      packedEnd: (packedSamples + len) / sampleRate
    });
    packedSamples += len;
  }

  const packedSec = packedSamples / sampleRate;
  // 15%以上短縮できる場合のみ無音スキップを適用
  if (packedSec >= totalSec * 0.85 || packedSec < 1.5) {
    return null;
  }

  const packedAudio = new Float32Array(packedSamples);
  let cursor = 0;
  for (const r of ranges) {
    const slice = audio.subarray(r.origStartSample, r.origEndSample);
    packedAudio.set(slice, cursor);
    cursor += slice.length;
  }

  return { packedAudio, ranges, savedSec: totalSec - packedSec };
}

function mapPackedTimeToOriginal(packedT, ranges) {
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (packedT <= r.packedStart) return r.origStart;
    if (packedT <= r.packedEnd) return r.origStart + (packedT - r.packedStart);
  }
  return ranges[ranges.length - 1].origEnd;
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

async function createPipelineWithProgress(modelId, device) {
  const fileStats = new Map();
  let compileTimer = null;

  const stopCompileTimer = () => {
    if (compileTimer) {
      clearInterval(compileTimer);
      compileTimer = null;
    }
  };

  const deviceLabel = device === "webgpu" ? "WebGPU 高速モード" : "CPU 標準モード";
  const dtypeOption = device === "webgpu"
    ? { encoder_model: "fp32", decoder_model_merged: "q4" }
    : "q8";

  self.postMessage({
    type: "status",
    phase: "model-init",
    percent: 6,
    text: `AIモデルを準備中（${deviceLabel}）…`,
    detail: `${modelId} · 初回はモデル取得と初期化を行います`
  });

  try {
    const instance = await pipeline("automatic-speech-recognition", modelId, {
      dtype: dtypeOption,
      device,
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
          const percent = Math.min(20, 6 + ratio * 14);
          const sizeInfo = total > 0 ? ` (${formatMB(loaded)} / ${formatMB(total)})` : "";

          self.postMessage({
            type: "model-progress",
            phase: "downloading",
            percent,
            text: `AIモデルを取得中（${deviceLabel}）…`,
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
              text: `${deviceLabel}を初期化中…`,
              detail: "初回のみ数秒〜数十秒かかります"
            });
            compileTimer = setInterval(() => {
              const sec = (Date.now() - compileStart) / 1000;
              const pct = Math.min(24.8, 20.5 + 4.3 * (1 - Math.exp(-sec / 10)));
              self.postMessage({
                type: "status",
                phase: "compiling",
                percent: pct,
                text: `${deviceLabel}を初期化中…`,
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
            text: `AIモデル準備完了（${deviceLabel}）`,
            detail: "音声の文字起こし解析へ移行します"
          });
        }
      }
    });
    stopCompileTimer();
    return instance;
  } catch (err) {
    stopCompileTimer();
    throw err;
  }
}

async function getASR(modelKey, preferAutoGpu = true) {
  const key = MODEL_IDS[modelKey] ? modelKey : "base";
  const wantWebGPU = preferAutoGpu && (await canUseWebGPU());
  const targetDevice = wantWebGPU ? "webgpu" : "wasm";
  const cacheTag = `${key}:${targetDevice}`;

  if (asrPipeline && loadedKey === cacheTag) {
    return { asr: asrPipeline, wasCachedInMemory: true, device: activeDeviceUsed };
  }
  if (loadPromise && loadedKey === cacheTag) {
    const asr = await loadPromise;
    return { asr, wasCachedInMemory: false, device: activeDeviceUsed };
  }

  loadedKey = cacheTag;
  asrPipeline = null;
  const modelId = MODEL_IDS[key];

  loadPromise = (async () => {
    env.allowLocalModels = false;
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
    }

    if (targetDevice === "webgpu") {
      try {
        const gpuAsr = await createPipelineWithProgress(modelId, "webgpu");
        activeDeviceUsed = "webgpu";
        asrPipeline = gpuAsr;
        return gpuAsr;
      } catch {
        // WebGPU初期化失敗時は自動でWASMにフォールバック
        loadedKey = `${key}:wasm`;
      }
    }

    const wasmAsr = await createPipelineWithProgress(modelId, "wasm");
    activeDeviceUsed = "wasm";
    asrPipeline = wasmAsr;
    return wasmAsr;
  })();

  try {
    const asr = await loadPromise;
    return { asr, wasCachedInMemory: false, device: activeDeviceUsed };
  } catch (err) {
    asrPipeline = null;
    loadPromise = null;
    loadedKey = null;
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
    const preferAutoGpu = data.accelDevice !== "wasm";
    let { asr, wasCachedInMemory, device } = await getASR(modelKey, preferAutoGpu);

    const rawAudio = new Float32Array(data.audio);
    const sampleRate = 16000;
    const origDurationSeconds = rawAudio.length / sampleRate;

    // 無音スキップ（VAD）の適用
    let targetAudio = rawAudio;
    let vadResult = null;
    if (data.skipSilence !== false) {
      vadResult = extractSpeechRegions(rawAudio, sampleRate);
      if (vadResult) {
        targetAudio = vadResult.packedAudio;
      }
    }

    const targetDuration = targetAudio.length / sampleRate;
    const chunkLengthS = 30;
    const strideLengthS = 2.5; // ストライド最適化でブロック数を削減
    const effectiveStepS = chunkLengthS - strideLengthS * 2;
    const estimatedChunks = Math.max(1, Math.ceil(targetDuration / effectiveStepS));

    const inferStartPct = wasCachedInMemory ? 8 : 25;
    const inferEndPct = 96;
    const inferSpanPct = inferEndPct - inferStartPct;

    let processedChunks = 0;
    const inferStartedAt = Date.now();
    let lastChunkAt = inferStartedAt;
    let avgChunkMs = INITIAL_CHUNK_MS[device]?.[modelKey] || 5000;
    let lastReportedPct = inferStartPct;

    const modeBadge = device === "webgpu" ? "WebGPU高速" : "CPU標準";
    const vadBadge = vadResult ? ` · 無音${Math.round(vadResult.savedSec)}秒短縮` : "";

    const emitInferProgress = () => {
      const now = Date.now();
      const sinceLastMs = Math.max(0, now - lastChunkAt);
      const intraFraction = processedChunks >= estimatedChunks
        ? 0.95
        : 0.92 * (1 - Math.exp(-2.2 * (sinceLastMs / Math.max(400, avgChunkMs))));

      const effectiveCompleted = Math.min(estimatedChunks - 0.05, processedChunks + intraFraction);
      const rawPct = inferStartPct + (effectiveCompleted / estimatedChunks) * inferSpanPct;
      const pct = Math.min(inferEndPct, Math.max(lastReportedPct, rawPct));
      lastReportedPct = pct;

      const currentBlock = Math.min(estimatedChunks, processedChunks + 1);
      const analyzedSec = Math.min(targetDuration, effectiveCompleted * effectiveStepS);
      const remainingChunks = Math.max(0, estimatedChunks - effectiveCompleted);
      const etaSec = (remainingChunks * avgChunkMs) / 1000;

      const etaText = etaSec >= 2 ? ` · 残り約 ${formatSecShort(etaSec)}` : " · まもなく完了";
      self.postMessage({
        type: "infer-progress",
        phase: "inferring",
        percent: pct,
        text: `文字起こし中（${modeBadge} · ブロック ${currentBlock}/${estimatedChunks}）`,
        detail: `解析: ${formatTimecode(analyzedSec)} / ${formatTimecode(targetDuration)}${vadBadge}${etaText}`
      });
    };

    emitInferProgress();
    smoothTimer = setInterval(emitInferProgress, 300);

    const runInference = async (pipelineInstance) => {
      return pipelineInstance(targetAudio, {
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
          const measuredAvg = (now - inferStartedAt) / processedChunks;
          avgChunkMs = measuredAvg * 0.8 + avgChunkMs * 0.2;
          emitInferProgress();
        }
      });
    };

    let result;
    try {
      result = await runInference(asr);
    } catch (gpuRunErr) {
      // WebGPU推論途中でエラーが起きた場合は自動でCPU(WASM)に切り替えて再試行
      if (device === "webgpu") {
        stopSmoothTimer();
        processedChunks = 0;
        lastReportedPct = 10;
        const fallback = await getASR(modelKey, false);
        asr = fallback.asr;
        device = "wasm";
        avgChunkMs = INITIAL_CHUNK_MS.wasm[modelKey] || 5200;
        emitInferProgress();
        smoothTimer = setInterval(emitInferProgress, 350);
        result = await runInference(asr);
      } else {
        throw gpuRunErr;
      }
    }

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
      : [{ timestamp: [0, targetDuration], text: result?.text || "" }];

    const rawSegments = rawChunks.map((c, idx) => {
      const pStart = Math.max(0, Number(c.timestamp?.[0] ?? 0));
      const tsEnd = c.timestamp?.[1];
      let pEnd = Number.isFinite(tsEnd) ? Number(tsEnd) : targetDuration;
      if (pEnd <= pStart) {
        const nextStart = rawChunks[idx + 1]?.timestamp?.[0];
        pEnd = Number.isFinite(nextStart) && nextStart > pStart
          ? Number(nextStart)
          : Math.min(targetDuration, pStart + 1.0);
      }

      const origStart = vadResult ? mapPackedTimeToOriginal(pStart, vadResult.ranges) : pStart;
      const origEnd = vadResult ? mapPackedTimeToOriginal(pEnd, vadResult.ranges) : pEnd;

      return {
        start: Math.min(origDurationSeconds, origStart),
        end: Math.min(origDurationSeconds, Math.max(origStart + 0.1, origEnd)),
        text: (c.text || "").trim()
      };
    }).filter((s) => s.text);

    const segments = collapseRepetitions(rawSegments);
    self.postMessage({
      type: "result",
      segments,
      deviceUsed: device,
      savedSec: vadResult ? vadResult.savedSec : 0
    });
  } catch (error) {
    stopSmoothTimer();
    self.postMessage({
      type: "error",
      message: error?.message || String(error)
    });
  }
};
