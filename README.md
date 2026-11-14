# Podcast AI Director

ブラウザ上で動作するポッドキャスト編集Webアプリ。AIを活用して音声の文字起こしから編集・書き出しまでを端末内で完結させます。

## v0.6.3 変更内容

- **FFmpeg Web Worker のクロスオリジンエラー修正**: CDN (`cdn.jsdelivr.net`) 上の `worker.js` を直接起動しようとしてブラウザの同一オリジンポリシーでブロックされる問題を解消するため、同一オリジンの `ffmpeg-worker.js` を追加し、`FFmpeg.load({ classWorkerURL, ... })` で読み込むように修正しました。
- **キャッシュ更新（`?v=0.6.3`）**: `index.html` / `app.js` / `style.css` / `transcribe-worker.js` / `ffmpeg-worker.js` の参照URLを更新しました。
