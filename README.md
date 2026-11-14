# Podcast AI Director

ブラウザ上で動作するポッドキャスト編集Webアプリ。AIを活用して音声の文字起こしから編集・書き出しまでを端末内で完結させます。

## v0.6.2 変更内容

- **キャッシュ自動更新（`?v=0.6.2`）**: `index.html` / `app.js` / `style.css` / `transcribe-worker.js` の参照URLにバージョンパラメータを付与し、GitHub Pages 更新後にブラウザの古いキャッシュが残る問題を解消しました。
- **ONNX初期化フェーズの判定精度向上**: 設定ファイル（`preprocessor_config.json` 等）完了後に行われる ONNX Runtime WASM の読み込み・コンパイル状態を正確に検知し、進捗表示と案内メッセージを更新するようにしました。
