import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2";

const MODEL_IDS = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small"
};

const INITIAL_CHUNK_MS = {
  wasm: { tiny: 1800, base: 3200, small: 6500 },
  webgpu: { tiny: 450, base: 800, small: 1500 }
};

let loadedKey = null; // `${modelKey}:${device}`
let asrPipeline = null;
let loadPromise = null;
let activeDeviceUsed = "wasm";

function formatMB(bytes) {
  return (bytes / 1048576).toFixed(1) + " MB";
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

function withTimeout(promise, ms, timeoutMessage) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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

/**
 * 音声配列を約15秒単位のウィンドウに分割（無音付近で区切り、頻繁な進捗更新とWebGPUハング防止を両立）
 */
function splitAudioIntoWindows(audio, sampleRate = 16000) {
  const totalSamples = audio.length;
  const maxWinSamples = Math.floor(15.0 * sampleRate);
  const minWinSamples = Math.floor(10.0 * sampleRate);
  const stepScan = Math.floor(0.1 * sampleRate); // 100ms単位で無音探索

  if (totalSamples <= maxWinSamples) {
    return [{ startSample: 0, endSample: totalSamples, startSec: 0, endSec: totalSamples / sampleRate }];
  }

  const windows = [];
  let cursor = 0;

  while (cursor < totalSamples) {
    if (totalSamples - cursor <= maxWinSamples) {
      windows.push({
        startSample: cursor,
        endSample: totalSamples,
        startSec: cursor / sampleRate,
        endSec: totalSamples / sampleRate
      });
      break;
    }

    const searchStart = cursor + minWinSamples;
    const searchEnd = Math.min(totalSamples, cursor + maxWinSamples);
    let bestSplit = searchEnd;
    let lowestRms = Infinity;

    for (let pos = searchStart; pos + stepScan <= searchEnd; pos += stepScan) {
      let sumSq = 0;
      for (let j = 0; j < stepScan; j += 4) {
        const v = audio[pos + j];
        sumSq += v * v;
      }
      const rms = sumSq / (stepScan / 4);
      if (rms < lowestRms) {
        lowestRms = rms;
        bestSplit = pos + Math.floor(stepScan / 2);
      }
    }

    windows.push({
      startSample: cursor,
      endSample: bestSplit,
      startSec: cursor / sampleRate,
      endSec: bestSplit / sampleRate
    });
    cursor = bestSplit;
  }

  return windows;
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
    device,
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
            device,
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
              device,
              percent: 20.5,
              text: `${deviceLabel}を初期化中…`,
              detail: "初回のみ数秒かかります"
            });
            compileTimer = setInterval(() => {
              const sec = (Date.now() - compileStart) / 1000;
              const pct = Math.min(24.8, 20.5 + 4.3 * (1 - Math.exp(-sec / 8)));
              self.postMessage({
                type: "status",
                phase: "compiling",
                device,
                percent: pct,
                text: `${deviceLabel}を初期化中…`,
                detail: `モデル展開中（${Math.floor(sec)}秒経過）`
              });
            }, 350);
          } else if (!compileTimer) {
            self.postMessage({
              type: "status",
              phase: "downloading",
              device,
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
            device,
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
      const canMultiThread = Boolean(self.crossOriginIsolated);
      env.backends.onnx.wasm.numThreads = canMultiThread
        ? Math.min(4, Math.max(1, navigator.hardwareConcurrency || 2))
        : 1;
      env.backends.onnx.wasm.proxy = false;
    }

    if (targetDevice === "webgpu") {
      try {
        const gpuAsr = await withTimeout(
          createPipelineWithProgress(modelId, "webgpu"),
          35000,
          "WebGPUモデルの初期化がタイムアウトしました"
        );
        activeDeviceUsed = "webgpu";
        asrPipeline = gpuAsr;
        return gpuAsr;
      } catch {
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

  try {
    const modelKey = MODEL_IDS[data.model] ? data.model : "base";
    const preferAutoGpu = data.accelDevice !== "wasm";
    const { asr, wasCachedInMemory, device } = await getASR(modelKey, preferAutoGpu);

    const rawAudio = new Float32Array(data.audio);
    const sampleRate = 16000;
    const origDurationSeconds = rawAudio.length / sampleRate;

    // 1. 無音スキップ（VAD）の適用
    let targetAudio = rawAudio;
    let vadResult = null;
    if (data.skipSilence !== false) {
      vadResult = extractSpeechRegions(rawAudio, sampleRate);
      if (vadResult) {
        targetAudio = vadResult.packedAudio;
      }
    }

    const targetDuration = targetAudio.length / sampleRate;
    const savedSec = vadResult ? vadResult.savedSec : 0;

    // 2. 約15秒ごとのウィンドウに分割（頻繁な進捗更新＆ハング防止）
    const windows = splitAudioIntoWindows(targetAudio, sampleRate);
    const totalBlocks = windows.length;

    const inferStartPct = wasCachedInMemory ? 8 : 25;
    const inferEndPct = 96;
    let avgBlockMs = INITIAL_CHUNK_MS[device]?.[modelKey] || 3000;

    self.postMessage({
      type: "infer-init",
      device,
      totalBlocks,
      targetDuration,
      savedSec,
      inferStartPct,
      inferEndPct,
      avgBlockMs
    });

    const collectedRawSegments = [];

    for (let idx = 0; idx < totalBlocks; idx++) {
      const win = windows[idx];
      const slice = targetAudio.subarray(win.startSample, win.endSample);
      const sliceDuration = slice.length / sampleRate;
      const blockStartedAt = Date.now();

      self.postMessage({
        type: "block-start",
        device,
        blockIndex: idx,
        totalBlocks,
        winStartSec: win.startSec,
        winEndSec: win.endSec,
        targetDuration,
        savedSec,
        avgBlockMs
      });

      const runBlock = () => asr(slice, {
        language: data.language || "japanese",
        task: "transcribe",
        return_timestamps: true,
        repetition_penalty: 1.1,
        no_repeat_ngram_size: 3
      });

      let blockResult;
      if (device === "webgpu") {
        // WebGPUが18秒（2ブロック目以降は12秒）応答しない場合はメインスレッド側でWorkerごと即再起動してCPU切替
        const limitMs = idx === 0 ? 18000 : 12000;
        try {
          blockResult = await withTimeout(runBlock(), limitMs, "WEBGPU_HANG");
        } catch (err) {
          if (err?.message === "WEBGPU_HANG") {
            self.postMessage({ type: "webgpu-stalled" });
            return;
          }
          throw err;
        }
      } else {
        blockResult = await runBlock();
      }

      const elapsedBlockMs = Math.max(150, Date.now() - blockStartedAt);
      avgBlockMs = idx === 0 ? elapsedBlockMs : (elapsedBlockMs * 0.7 + avgBlockMs * 0.3);

      self.postMessage({
        type: "block-done",
        device,
        blockIndex: idx,
        totalBlocks,
        winEndSec: win.endSec,
        targetDuration,
        savedSec,
        elapsedBlockMs,
        avgBlockMs
      });

      const rawChunks = Array.isArray(blockResult?.chunks) && blockResult.chunks.length
        ? blockResult.chunks
        : [{ timestamp: [0, sliceDuration], text: blockResult?.text || "" }];

      for (let cIdx = 0; cIdx < rawChunks.length; cIdx++) {
        const c = rawChunks[cIdx];
        const localStart = Math.max(0, Number(c.timestamp?.[0] ?? 0));
        const tsEnd = c.timestamp?.[1];
        let localEnd = Number.isFinite(tsEnd) ? Number(tsEnd) : sliceDuration;
        if (localEnd <= localStart) {
          const nextStart = rawChunks[cIdx + 1]?.timestamp?.[0];
          localEnd = Number.isFinite(nextStart) && nextStart > localStart
            ? Number(nextStart)
            : Math.min(sliceDuration, localStart + 1.0);
        }

        const packedStart = win.startSec + localStart;
        const packedEnd = win.startSec + Math.min(sliceDuration, localEnd);
        const origStart = vadResult ? mapPackedTimeToOriginal(packedStart, vadResult.ranges) : packedStart;
        const origEnd = vadResult ? mapPackedTimeToOriginal(packedEnd, vadResult.ranges) : packedEnd;
        const text = (c.text || "").trim();

        if (text) {
          collectedRawSegments.push({
            start: Math.min(origDurationSeconds, origStart),
            end: Math.min(origDurationSeconds, Math.max(origStart + 0.1, origEnd)),
            text
          });
        }
      }
    }

    self.postMessage({
      type: "status",
      phase: "postprocess",
      device,
      percent: 98,
      text: "タイムスタンプと文章を整形中…",
      detail: ""
    });

    const segments = collapseRepetitions(collectedRawSegments);
    self.postMessage({
      type: "result",
      segments,
      deviceUsed: device,
      savedSec
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error?.message || String(error)
    });
  }
};
