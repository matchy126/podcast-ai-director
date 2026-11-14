Podcast AI Director v0.6

Changes from v0.5:
1. app.js now uses Web Worker for transcription (fixes UI freeze)
2. AudioContext decoding implemented (mono + 16kHz resampling)
3. Worker uses Whisper standard chunk_length_s=30, stride_length_s=5
4. FFmpeg load fix retained from v0.5

Files:
- index.html
- style.css
- app.js
- transcribe-worker.js

Deploy to GitHub Pages by uploading these files to your repository.
