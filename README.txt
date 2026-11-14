Podcast AI Director - transcription fix v0.8

Replace the existing index.html and app.js in your GitHub Pages repository with these files, and add transcribe-worker.js in the same directory.
Keep your existing style.css file in place.

What changed:
- Audio decoding/resampling is done before transcription.
- Whisper runs in a Web Worker so inference does not occupy the page's main thread.
- Audio is processed in sequential 25-second segments.
- Progress advances for each completed segment rather than remaining fixed at 62%.
- Transcription errors are shown in the existing progress area (no alert popup).

Notes:
- The first run still needs to download the selected Whisper model.
- This has passed JavaScript syntax checks, but actual inference must be tested in the target browser/device.
- For low-memory devices, choose Tiny first. Base and Small require more memory and processing time.
