import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2";
let busy = false;
self.onmessage = async ({ data }) => {
  if (data?.type !== "transcribe" || busy) return;
  busy = true;
  let audioUrl;
  try {
    const models = { tiny: "onnx-community/whisper-tiny", base: "onnx-community/whisper-base", small: "onnx-community/whisper-small" };
    const modelId = models[data.model] || models.tiny;
    env.allowLocalModels = false;
    // Conservative WASM settings for low-spec school PCs.
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
    self.postMessage({ type: "status", stage: "initializing", detail: `モデル: ${modelId}。初回はモデルの準備に時間がかかります。` });
    const asr = await pipeline("automatic-speech-recognition", modelId, {
      dtype: "q8", device: "wasm",
      progress_callback: (p) => {
        if (p.status === "progress") self.postMessage({ type: "progress", percent: Number.isFinite(p.progress) ? p.progress : null, label: "AIモデルをダウンロード中…", detail: p.file || p.name || "モデルファイルを取得しています" });
        else if (p.status === "initiate") self.postMessage({ type: "progress", percent: null, label: "モデルファイルを準備中…", detail: p.file || p.name || "" });
        else if (p.status === "done") self.postMessage({ type: "status", stage: "initializing", detail: `${p.file || p.name || "モデルファイル"} を読み込みました。推論エンジンを初期化しています。` });
      }
    });
    audioUrl = URL.createObjectURL(data.file);
    self.postMessage({ type: "status", stage: "transcribing", detail: "音声を解析しています。長い録音では数分以上かかる場合があります。" });
    const result = await asr(audioUrl, { language: data.language || "japanese", task: "transcribe", chunk_length_s: 20, stride_length_s: 4, return_timestamps: true });
    const chunks = result.chunks || [{ timestamp: [0, null], text: result.text || "" }];
    const segments = chunks.map(c => ({ start: Number(c.timestamp?.[0] || 0), end: Number(c.timestamp?.[1] || 0), text: (c.text || "").trim() })).filter(c => c.text);
    self.postMessage({ type: "result", segments });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.stack || error?.message || String(error) });
  } finally {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    busy = false;
  }
};
