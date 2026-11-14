# Podcast AI Director (GitHub Pages v0.5)

## コンセプト
1. ブラウザで音声を文字起こしし、タイムスタンプ付きTXT/JSONを作成
2. 編集依頼テンプレートと一緒に好きなAI（ChatGPT / Gemini / Claude等）へ渡す
3. AIが共通JSON形式の編集指示を返す
4. JSONを貼り付け/読み込み、検証・タイムラインで確認
5. ブラウザ内FFmpeg.wasmで編集し、MP3/WAVを書き出す
6. 元音源と完成音源を並べて再生・比較

## GitHub Pages公開
1. ZIPを展開し、`index.html`, `style.css`, `app.js`, `README.md` をリポジトリ直下に置く
2. GitHubリポジトリの Settings → Pages → Build and deployment
3. Sourceを「Deploy from a branch」、Branchを `main`、Folderを `/ (root)` にしてSave
4. 数分後 `https://<username>.github.io/<repo>/` で公開

## 編集JSON v1
時刻はすべて**元音源上の秒数**です。カット後の位置へ自動変換して処理します。

```json
{
  "version": 1,
  "operations": [
    {"type":"cut","start":12.5,"end":18.2,"reason":"長い沈黙"},
    {"type":"bgm","start":20,"end":60,"track":"main","volume":0.12,"fade_in":2,"fade_out":3},
    {"type":"bgm","start":90,"end":120,"track":"main","volume":0.08},
    {"type":"fade","start":0,"end":2,"effect":"in"},
    {"type":"fade","start":118,"end":120,"effect":"out"},
    {"type":"marker","time":120,"label":"話題転換"}
  ],
  "notes": ["確認事項"]
}
```

許可されるtypeは `cut`, `bgm`, `fade`, `marker`。任意コードは実行しません。

- `cut`: 元音源のstart〜endを削除。重複カットは検証時にエラーになります。
- `bgm`: 選択したBGMファイルを元音源のstart〜endに配置。volumeは0〜1。複数区間・区間ごとの音量に対応します。任意の`fade_in`/`fade_out`（秒）で各BGM区間の頭と末尾を個別にフェードできます。カット区間をまたぐ場合、BGMも元音源上の時間に沿って進み、出力上ではカット分だけ詰まります。
- `fade`: 指定範囲をフェードイン/アウト。現行版では会話とBGMを含むミックス全体に適用します。
- `marker`: タイムライン上の目印。音声には影響しません。

## v0.4の追加
- BGMをstart/endで区間配置し、複数区間と区間ごとの音量を処理
- カット後の出力時間へBGMとフェードの位置を変換
- 元音源と完成音源のA/B再生欄
- CUT / BGM / FADE / MARKの簡易タイムライン。レーンやイベントをクリックすると元音源プレイヤーが該当時刻へ移動して再生
- 音源長を読み取り、範囲外の編集指示を検証

## v0.5の追加
- BGM区間ごとのfade_in / fade_out（秒）に対応
- タイムラインのレーン・イベントをクリックして元音源の該当位置を試聴

## 現状の制約
- Whisper文字起こしはTransformers.js経由。モデルは初回CDNから取得し、端末内で推論。
- タイムスタンプはWhisperのチャンク単位。厳密な単語単位のタイムコードではありません。
- すべてのBGM区間で同じBGMファイルを使用します。区間ごとに異なる曲を指定する機能、BGM専用の個別フェード、クロスフェードは未対応です。
- fadeはミックス全体に作用します。区間をまたぐ複雑なカットや重複フェードは、書き出し後の試聴が必要です。
- A/Bはそれぞれ独立したプレイヤーです。同時再生を避けるため、比較時は片方を一時停止してください。
- 文字起こし、FFmpeg処理はブラウザのCPU/メモリに依存。学校用PCでは5〜10分程度の短い音源から検証してください。
- CDNからライブラリ/AIモデルを取得しますが、収録音声そのものは外部サーバーへ送信しません。
- 本番利用前にChrome/Edge/Safariの動作確認、長時間音源の負荷試験、CORS/WASMの確認が必要です。
- 音声の誤カット防止のため、必ず書き出し音源を聞き直してください。
