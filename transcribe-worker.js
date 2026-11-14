import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2";

const MODEL_IDS = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small"
};
let asrPromise;

async function getASR(model) {
  if (!asrPromise) {
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
          self.postMessage({ type: "status", text: `${p.file || p.name || "モデルファイル"} 読み込み完了。推論エンジンを準備中…` });
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
    const chunkSeconds = 25;
    const chunkSamples = chunkSeconds * sampleRate;
    const totalChunks = Math.ceil(audio.length / chunkSamples);
    const segments = [];

    self.postMessage({ type: "started", totalChunks, duration: audio.length / sampleRate });

    for (let i = 0; i < totalChunks; i++) {
      const startSample = i * chunkSamples;
      const endSample = Math.min(audio.length, startSample + chunkSamples);
      const part = audio.slice(startSample, endSample);
      const offset = startSample / sampleRate;
      self.postMessage({ type: "status", text: `音声を解析中…（${i + 1}/${totalChunks} 区間）` });

      const result = await asr(part, {
        sampling_rate: sampleRate,
        language: data.language || "japanese",
        task: "transcribe",
        return_timestamps: true
      });

      const chunks = result.chunks || [{ timestamp: [0, part.length / sampleRate], text: result.text || "" }];
      for (const c of chunks) {
        const localStart = Number(c.timestamp?.[0] ?? 0);
        const localEnd = Number(c.timestamp?.[1] ?? part.length / sampleRate);
        const text = (c.text || "").trim();
        if (!text) continue;
        segments.push({ start: offset + localStart, end: offset + localEnd, text });
      }

      self.postMessage({ type: "chunk-progress", completed: i + 1, total: totalChunks });
    }

    self.postMessage({ type: "result", segments });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.stack || error?.message || String(error) });
  }
};
