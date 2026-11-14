import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2";

const MODEL_IDS = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small"
};

let asrPromise = null;
let currentModel = null;

async function getASR(model) {
  // モデルが変わったらキャッシュを破棄
  if (currentModel !== model && asrPromise) {
    asrPromise = null;
  }
  if (!asrPromise) {
    currentModel = model;
    env.allowLocalModels = false;
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
    const modelId = MODEL_IDS[model] || MODEL_IDS.tiny;
    self.postMessage({ type: "status", text: `モデルを準備中：${modelId}` });
    asrPromise = pipeline("automatic-speech-recognition", modelId, {
      dtype: "q8",
      device: "wasm",
      progress_callback: p => {
        if (p.status === "progress") {
          self.postMessage({
            type: "model-progress",
            percent: Number.isFinite(p.progress) ? p.progress : null,
            detail: p.file || p.name || "モデルファイルを取得中"
          });
        } else if (p.status === "done") {
          self.postMessage({ type: "status", text: `${p.file || p.name || "モデルファイル"} 読み込み完了` });
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
    const audio = new Float32Array(data.audio);
    const sampleRate = 16000;

    self.postMessage({ type: "status", text: "音声を解析中…", detail: `${audio.length} samples @ ${sampleRate}Hz` });

    // Whisper標準の chunk_length_s=30, stride_length_s=5 を使用
    // Transformers.js の pipeline に任せる（長い音声を自動でチャンク処理）
    const result = await asr(audio, {
      sampling_rate: sampleRate,
      language: data.language || "japanese",
      task: "transcribe",
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5
    });

    const chunks = result.chunks || [{ timestamp: [0, audio.length / sampleRate], text: result.text || "" }];
    const segments = [];
    for (const c of chunks) {
      const start = Number(c.timestamp?.[0] ?? 0);
      const end = Number(c.timestamp?.[1] ?? audio.length / sampleRate);
      const text = (c.text || "").trim();
      if (!text) continue;
      segments.push({ start, end, text });
    }

    self.postMessage({ type: "result", segments });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.stack || error?.message || String(error) });
  }
};
