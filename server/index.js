import express from 'express';
import cors from 'cors';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { pipeline } from '@xenova/transformers';
import ffmpegStatic from 'ffmpeg-static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DL = path.join(__dirname, 'downloads');
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
// ffmpeg: use FFMPEG_PATH, else a system ffmpeg, else the copy bundled by the ffmpeg-static package
const FFMPEG = process.env.FFMPEG_PATH || (spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : ffmpegStatic);
const app = express();
app.use(cors());
app.use(express.json());
app.use('/files', express.static(DL)); // supports Range requests, so video seeking works

// POST /api/import { url } -> downloads with yt-dlp (YouTube, Vimeo, Twitch, X, Drive links, etc.)
app.post('/api/import', (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Paste a full link starting with http:// or https://' });
  const id = randomUUID();
  const args = [
    '--no-playlist', '--no-warnings', '--quiet',
    '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
    '--merge-output-format', 'mp4',
    ...(FFMPEG !== 'ffmpeg' ? ['--ffmpeg-location', FFMPEG] : []),
    '--print', 'title', '--no-simulate',
    '-o', path.join(DL, `${id}.%(ext)s`),
    '--', url,
  ];
  const p = spawn(YTDLP, args);
  let out = '', err = '', replied = false;
  const fail = (code, msg) => { if (!replied) { replied = true; res.status(code).json({ error: msg }); } };
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('error', (e) => fail(500, e.code === 'ENOENT' ? 'yt-dlp is not installed (or not on PATH). Install it from github.com/yt-dlp/yt-dlp and restart the server.' : e.message));
  p.on('close', (code) => {
    const file = path.join(DL, `${id}.mp4`);
    if (code === 0 && existsSync(file)) {
      replied = true;
      return res.json({ file: `/files/${id}.mp4`, title: out.trim().split('\n')[0] || 'Imported video' });
    }
    fail(500, (err.trim().split('\n').pop() || 'Download failed').slice(0, 300));
  });
});

// ---------- Transcription (Whisper) + ML viral scoring, on the server ----------
const MAX_MIN = Number(process.env.MAX_MIN || 15);
let asr, emb;
const PROTOTYPES = [
  'A shocking surprising statement that grabs attention immediately',
  'A bold controversial opinion that most people disagree with',
  'A secret shortcut or hack that saves a lot of time or money',
  'A common mistake everyone makes and how to avoid it',
  'A powerful emotional personal story with a lesson',
  'A question that makes the viewer curious and want to keep watching',
  'A surprising statistic or fact that changes how you think',
  'Actionable step by step advice you can use today',
];
function audioSamples(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', file, '-t', String(MAX_MIN * 60), '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
    const bufs = []; let err = '';
    p.stdout.on('data', (d) => bufs.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffmpeg is not installed (or not on PATH).' : e.message)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || 'Could not read audio from this file'));
      const b = Buffer.concat(bufs);
      const i16 = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
      resolve(f32);
    });
  });
}
async function mlScores(texts) {
  emb = emb || (await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'));
  const out = await emb([...PROTOTYPES, ...texts], { pooling: 'mean', normalize: true });
  const d = out.dims[1];
  const vec = (i) => out.data.slice(i * d, (i + 1) * d);
  const protos = PROTOTYPES.map((_, i) => vec(i));
  return texts.map((_, i) => {
    const v = vec(PROTOTYPES.length + i);
    const best = Math.max(...protos.map((q) => q.reduce((a, x, k) => a + x * v[k], 0)));
    return Math.max(0, Math.min(100, ((best - 0.1) / 0.5) * 100));
  });
}
// Jobs: the upload returns a job id immediately; the browser polls for progress (no long-held requests).
const jobs = new Map();
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found (the server may have restarted). Try again.' });
  res.json(j);
});
// Cleans Whisper output: drops [music]/(noise) tags and splits long chunks into short phrases with sensible timing.
const clean = (t) => t.replace(/[\[\(][^\]\)]*[\]\)]/g, ' ').replace(/[♪♫]/g, ' ').replace(/\s{2,}/g, ' ').trim();
function toSegments(chunks) {
  const out = [];
  for (const c of chunks) {
    const words = clean(c.text).split(' ').filter(Boolean);
    if (!words.length) continue;
    const start = c.timestamp[0];
    const end = c.timestamp[1] ?? start + 3;
    const speechEnd = start + Math.min(end - start, Math.max(2, words.length / 2.5)); // ~2.5 words/sec
    const phrases = [];
    let cur = [];
    for (const w of words) {
      cur.push(w);
      if ((/[.!?]$/.test(w) && cur.length >= 3) || cur.length >= 12) { phrases.push(cur); cur = []; }
    }
    if (cur.length) phrases.push(cur);
    let t = start;
    for (const ph of phrases) {
      const d = ((speechEnd - start) * ph.length) / words.length;
      out.push({ id: out.length + 1, start: t, end: t + d, speaker: 'Speaker 1', text: ph.join(' ') });
      t += d;
    }
  }
  return out;
}
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'Xenova/whisper-tiny.en'; // use Xenova/whisper-base.en for better accuracy (slower)
async function runJob(job, file, temp) {
  const say = (m) => { job.message = m; console.log('  >', m); };
  try {
    say('Extracting audio...');
    const audio = await audioSamples(file);
    const audioSec = audio.length / 16000;
    if (!asr) {
      say(`Preparing Whisper model (${WHISPER_MODEL}, first run downloads it)...`);
      const files = {};
      let lastLogged = -1;
      try {
        asr = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
          progress_callback: (p) => {
            if (p.status === 'progress') {
              files[p.file] = { loaded: p.loaded, total: p.total };
              const all = Object.values(files);
              const loaded = all.reduce((a, f) => a + f.loaded, 0) / 1048576;
              const total = all.reduce((a, f) => a + f.total, 0) / 1048576;
              job.message = `Downloading Whisper model: ${loaded.toFixed(0)} of ${total.toFixed(0)} MB so far (${p.file.split('/').pop()})`;
              if (Math.floor(loaded / 10) !== lastLogged) { lastLogged = Math.floor(loaded / 10); console.log('  >', job.message); }
            } else if (p.status === 'done') {
              console.log('  > downloaded', p.file);
            } else if (p.status === 'ready') {
              say('Whisper model ready, starting transcription...');
            }
          },
        });
      } catch (e) {
        console.error(e);
        throw new Error('Could not load the Whisper model. The first run needs internet access to huggingface.co. Check your connection/firewall and try again.');
      }
    }
    const totalChunks = Math.max(1, Math.ceil(audioSec / 25));
    let doneChunks = 0;
    say(`Transcribing ${Math.round(audioSec / 60 * 10) / 10} minutes of speech...`);
    const out = await asr(audio, {
      chunk_length_s: 30, stride_length_s: 5, return_timestamps: true,
      chunk_callback: () => { doneChunks++; say(`Transcribing speech: part ${Math.min(doneChunks, totalChunks)} of about ${totalChunks}`); },
    });
    const segments = toSegments(out.chunks);
    if (!segments.length) throw new Error('No clear English speech found (only music/noise or another language). This model is English-only.');
    say(emb ? 'Scoring viral moments...' : 'Downloading viral-scoring model (first run ~25MB), then scoring...');
    const ml = await mlScores(segments.map((s) => s.text)).catch((e) => { console.error(e); return segments.map(() => 50); });
    job.result = { segments, ml };
    job.status = 'done';
    console.log('  > done:', segments.length, 'segments');
  } catch (e) {
    console.error(e);
    job.status = 'error';
    job.error = e.message;
  } finally {
    if (temp && file) unlink(file).catch(() => {});
  }
}
app.post('/api/transcribe', async (req, res) => {
  try {
    let file, temp = false;
    if ((req.headers['content-type'] || '').startsWith('application/octet-stream')) {
      file = path.join(DL, `${randomUUID()}.upload`); temp = true;
      await streamPipeline(req, createWriteStream(file)); // streamed to disk, not held in memory
    } else {
      const f = String(req.body?.file || '');
      if (!/^\/files\/[\w-]+\.mp4$/.test(f)) return res.status(400).json({ error: 'Send a video file, or a /files/... path from a link import.' });
      file = path.join(DL, path.basename(f));
    }
    const id = randomUUID();
    jobs.set(id, { status: 'running', message: 'Starting...' });
    setTimeout(() => jobs.delete(id), 3600000);
    console.log('Transcribing', file);
    runJob(jobs.get(id), file, temp);
    res.json({ jobId: id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

app.listen(3001, () => {
  console.log('Vizard backend on http://localhost:3001');
  [['ffmpeg', FFMPEG, '-version'], ['yt-dlp', YTDLP, '--version']].forEach(([name, bin, flag]) => {
    const ok = spawnSync(bin, [flag]).status === 0;
    console.log(ok ? `  OK      ${name} found` : `  MISSING ${name} - install it and make sure it is on your PATH (needed for ${name === 'ffmpeg' ? 'transcription' : 'link import'})`);
  });
});
