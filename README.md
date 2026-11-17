# Podcast AI Director (v0.8.5)

ブラウザ上で動作するポッドキャスト編集Webアプリ。AIを活用して音声の文字起こしから編集・書き出し・MP4動画化までを端末内で完結させます。

## v0.8.5 の改善点（`Unable to decode audio data` 解消・FFmpegデコード自動フォールバック）

1. **ブラウザ非対応コーデックの自動デコードフォールバック**
   - ブラウザ標準の `AudioContext.decodeAudioData` が対応していない形式（ALAC形式の `.m4a`、`.mp4`/`.mov`/`.mkv` 動画内の音声、`.wma`、`.aiff`、特殊WAV、一部ID3タグ付きMP3など）を読み込んだ際、`Unable to decode audio data` で停止せず、内蔵FFmpegエンジンへ自動フォールバックして16kHzモノラル／ステレオPCMへ直接デコードします。
2. **文字起こし・編集の両工程でフォールバック対応**
   - STEP 01の文字起こしだけでなく、STEP 04の音声編集（元音源・BGM・SE）でも同じ自動デコード処理が働くため、編集書き出しまでエラーなく完了できます。
