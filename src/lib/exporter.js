import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
let ff;
const pad = (n, l = 2) => String(n).padStart(l, '0');
const t = (s) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s) % 60)},${pad(Math.round((s % 1) * 1000), 3)}`;

async function loadFF(onStatus) {
  if (ff) return;
  onStatus('Loading video engine (first run ~30MB)...');
  ff = new FFmpeg();
  const base = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
  await ff.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
  });
}

// Pulls only the first maxSec seconds of audio as 16kHz mono samples (fast, low memory)
export async function extractAudio(url, maxSec, onStatus = () => {}) {
  await loadFF(onStatus);
  onStatus('Reading video file...');
  await ff.writeFile('a_in', await fetchFile(url));
  onStatus('Extracting audio...');
  await ff.exec(['-i', 'a_in', '-t', String(maxSec), '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'a.pcm']);
  const raw = await ff.readFile('a.pcm');
  await ff.deleteFile('a_in');
  await ff.deleteFile('a.pcm');
  const i16 = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
  const f32 = new Float32Array(i16.length);
  for (let n = 0; n < i16.length; n++) f32[n] = i16[n] / 32768;
  return f32;
}

// Real export: cut + crop (9:16 / 1:1 / 16:9) + burned-in captions, using ffmpeg.wasm in the browser.
export async function exportClip({ url, start, end, ratio, segs, onStatus = () => {} }) {
  await loadFF(onStatus);
  ff.on('progress', ({ progress }) => onStatus(`Rendering ${Math.round(Math.min(1, progress) * 100)}%`));
  onStatus('Preparing files...');
  await ff.writeFile('in.mp4', await fetchFile(url));
  await ff.writeFile('arial.ttf', await fetchFile('https://raw.githubusercontent.com/ffmpegwasm/testdata/master/arial.ttf'));
  const lines = segs.filter((s) => s.end > start && s.start < end);
  const srt = lines.map((s, i) => `${i + 1}\n${t(Math.max(0, s.start - start))} --> ${t(Math.min(end, s.end) - start)}\n${s.text}\n`).join('\n');
  await ff.writeFile('sub.srt', srt);
  const crop = ratio === '9:16' ? 'crop=ih*9/16:ih,scale=720:1280' : ratio === '1:1' ? 'crop=ih:ih,scale=720:720' : 'scale=1280:720';
  const style = "FontName=Arial,FontSize=18,Bold=1,Outline=2,Alignment=2,MarginV=60,PrimaryColour=&H00FFFFFF&";
  const vf = lines.length ? `${crop},subtitles=sub.srt:fontsdir=/:force_style='${style}'` : crop;
  await ff.exec(['-ss', String(start), '-i', 'in.mp4', '-t', String(end - start), '-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', 'out.mp4']);
  const data = await ff.readFile('out.mp4');
  return URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
}
