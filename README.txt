Podcast AI Director - FFmpeg load fix

Replace the app.js in your GitHub Pages repository with this file.
Keep index.html and style.css unchanged.

Fixes:
- FFmpeg instance is cached only after a successful load.
- A failed FFmpeg load clears the instance so retry does not skip ff.load().
- Concurrent load requests share one initialization promise.
- FFmpeg loading and initialization stages are displayed.
- Editing errors are shown in a selectable page area rather than only in a popup.

After committing, hard-refresh the deployed page (Ctrl+Shift+R). If the browser still serves an old module, clear the site's cached data or change the app.js URL/version query in index.html.
