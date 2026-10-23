# Vizard Clone (React + Vite + Tailwind + Node backend)

## One-time setup
1. Install Node 18+.
2. Install yt-dlp (only needed for YouTube/link import): https://github.com/yt-dlp/yt-dlp. ffmpeg is bundled automatically (a system ffmpeg is used if you have one).
   (Windows: `winget install yt-dlp.yt-dlp Gyan.FFmpeg`  |  Mac: `brew install yt-dlp ffmpeg`)
3. `npm install`

## Run
npm run dev:all     # starts the backend (3001) + the app; open the printed localhost URL in Chrome

Upload or import a video -> the backend (Node + ffmpeg + Whisper) transcribes it and the ML model scores viral moments. Always start with npm run dev:all. First run downloads ~100MB of models into the backend.
Without the backend you can still upload/record files: `npm run dev`.

## Troubleshooting
- On start, the terminal prints whether ffmpeg and yt-dlp were found. Fix any MISSING line, then restart.
- "Backend not reachable": you started with `npm run dev`; use `npm run dev:all`.
- First transcription is slow: ~100MB of models download once into the server cache.
- Transcription is English only. Only the first 15 minutes are processed (set MAX_MIN to change).
- Export uses ffmpeg in the browser: use Chrome/Edge, and expect it to be slow for 3-minute clips.
# Vizard.ai
