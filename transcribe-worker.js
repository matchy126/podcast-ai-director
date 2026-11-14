import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2";

let asrPromise = null;
const models = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small"
};

async function getASR(model) {
  if (!asrPromise) {
    env.allowLocalModels = false;
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
    const modelId = models[model] || models.tiny;
    self.postMessage({ type: "status", stage: "initializing", detail: `モデル ${modelId} を準備しています。` });
    asrPromise = pipeline("automatic-speech-recognition", modelId, {
      dtype: "q8",
      device: "wasm",
      progress_callback: p => {
        if (p.status === "progress") {
          self.postMessage({ type: "progress", percent: Number.isFinite(p.progress) ? p.progress : null, label: "AIモデルをダウンロード中…", detail: p.file || p.name || "モデルファイルを取得中" });
        } else if (p.status === "done") {
          self.postMessage({ type: "status", stage: "initializing", detail: `${p.file || p.name || "モデルファイル"} 読み込み完了。推論エンジンを準備中…` });
        }
      }
    });
  }
  return asrPromise;
}

self.onmessage = async event => {
  const data = event.data || {};
  if (data.type !== "transcribe") return;
  try {
    const asr = await getASR(data.model);
    self.postMessage({ type: "status", stage: "transcribing", detail: "音声を解析しています。" });
    // Audio is decoded and resampled on the main thread. Worker receives raw PCM,
    // avoiding AudioContext/object-URL loading inside the worker.
    const audio = new Float32Array(data.audio);
    const result = await asr(audio, {
      sampling_rate: 16000,
      language: data.language || "japanese",
      task: "transcribe",
      chunk_length_s: 20,
      stride_length_s: 4,
      return_timestamps: true
    });
    const chunks = result.chunks || [{ timestamp: [0, null], text: result.text || "" }];
    const segments = chunks.map(c => ({
      start: Number(c.timestamp?.[0] || 0),
      end: Number(c.timestamp?.[1] || 0),
      text: (c.text || "").trim()
    })).filter(c => c.text);
    self.postMessage({ type: "result", segments });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.stack || error?.message || String(error) });
  }
};
