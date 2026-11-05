import { spawn as nodeSpawn } from 'node:child_process';

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** Parse known public video URL shapes without ever fetching the URL itself. */
export function parseStyleReferenceUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
    const match = /^\/shorts\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
    const id = match?.[1] ?? (url.pathname === '/watch' ? url.searchParams.get('v') : null);
    if (!YOUTUBE_ID.test(id ?? '') || (url.pathname === '/watch' && [...url.searchParams.keys()].some((key) => key !== 'v'))) return null;
    return { platform: 'youtube', video_id: id, url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (host === 'youtu.be' && /^\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname) && !url.search) {
    const id = url.pathname.slice(1, 12);
    return { platform: 'youtube', video_id: id, url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (host === 'www.instagram.com' || host === 'instagram.com') {
    const match = /^\/reel\/([A-Za-z0-9_-]{5,50})\/?$/.exec(url.pathname);
    if (match && !url.search) return { platform: 'instagram', url: `https://www.instagram.com/reel/${match[1]}/` };
  }
  if (host === 'www.tiktok.com' || host === 'tiktok.com') {
    const match = /^\/@[A-Za-z0-9._-]{2,50}\/video\/(\d{10,25})\/?$/.exec(url.pathname);
    if (match && !url.search) return { platform: 'tiktok', url: `https://www.tiktok.com${url.pathname.replace(/\/$/, '')}` };
  }
  return null;
}

/** Probe a user-selected local video only; no media bytes or thumbnails leave the PC. */
export async function analyzeLocalStyleVideo(path, { ffprobePath = 'ffprobe', ffmpegPath = 'ffmpeg', spawn = nodeSpawn } = {}) {
  const probe = JSON.parse(await capture(spawn, ffprobePath, ['-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,width,height', '-of', 'json', path], 30_000, 'stdout'));
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const duration = Number(probe.format?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0 || !Number.isInteger(video.width) || !Number.isInteger(video.height)) {
    throw Object.assign(new Error('참고 영상의 길이와 화면 크기를 확인할 수 없습니다.'), { code: 'VALIDATION_ERROR', status: 422 });
  }
  const analyzedSeconds = Math.min(duration, 59);
  let cutTimes = []; let cutDetection = 'unavailable';
  try {
    const output = await capture(spawn, ffmpegPath, ['-hide_banner', '-nostdin', '-i', path, '-t', String(analyzedSeconds),
      '-vf', 'fps=2,scale=320:-2,select=gt(scene\\,0.3),showinfo', '-an', '-f', 'null', '-'], 45_000, 'stderr');
    cutTimes = [...output.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1]))
      .filter((time) => Number.isFinite(time) && time >= 0 && time <= analyzedSeconds).slice(0, 100);
    cutDetection = 'sampled_scene_threshold';
  } catch { /* A failed detector never becomes a claim about cuts. */ }
  const averageCutSeconds = cutDetection === 'sampled_scene_threshold' && cutTimes.length
    ? Number((analyzedSeconds / (cutTimes.length + 1)).toFixed(2)) : null;
  return { duration_seconds: Number(duration.toFixed(2)), width: video.width, height: video.height,
    aspect_ratio: Number((video.width / video.height).toFixed(3)), analyzed_seconds: Number(analyzedSeconds.toFixed(2)),
    cut_times_seconds: cutTimes, average_cut_seconds: averageCutSeconds, cut_detection: cutDetection,
    pace: averageCutSeconds === null ? 'unknown' : averageCutSeconds <= 2 ? 'fast' : averageCutSeconds >= 5 ? 'slow' : 'medium',
    limitations: ['2fps 축소 샘플의 화면 변화만 감지합니다. 실제 편집 컷과 다를 수 있습니다.',
      '자막 디자인·음악·후킹 방식·감정 분위기는 자동 판정하지 않았습니다.'] };
}

function capture(spawn, executable, args, timeoutMs, stream) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(new Error('로컬 미디어 도구를 실행할 수 없습니다.')); return; }
    let output = ''; let done = false;
    const finish = (error) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(output); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('참고 영상 분석 시간이 초과됐습니다.')); }, timeoutMs);
    child[stream].on('data', (chunk) => { if (output.length < 256_000) output += chunk.toString().slice(0, 256_000 - output.length); });
    child.once('error', () => finish(new Error('로컬 미디어 도구를 실행할 수 없습니다.')));
    child.once('close', (code) => finish(code === 0 ? null : new Error('참고 영상 분석에 실패했습니다.')));
  });
}
