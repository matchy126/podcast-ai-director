Podcast AI Director transcription fix

Replace the existing app.js with this app.js, and add/replace transcribe-worker.js in the same folder as index.html.
Keep index.html and style.css unchanged.

Fix:
- Main thread decodes the selected audio file with AudioContext.
- Stereo is mixed down to mono and resampled to 16 kHz.
- Float32 PCM is transferred to the module Worker.
- Worker passes PCM directly to Transformers.js Whisper pipeline instead of passing an object URL.
- Runtime errors remain visible in the existing progress detail area; no alert popup is used.

Deploy all files to GitHub Pages, then hard-refresh the page (Ctrl+Shift+R). If GitHub Pages caches the old worker, changing the worker file content and hard-refreshing should fetch the new module.

Note: Browser codec support applies to decoding the original file. WAV or MP3 are safest. Very long recordings can still require substantial RAM.
