import { lstatSync } from 'node:fs';
import { CREATOR_VIDEO_PROFILE } from './video-profile.js';

export async function inspectRenderedVideo({ spawn, ffprobePath = 'ffprobe', filePath, timeoutMs = 30_000, signal }) {
  let stat;
  try { stat = lstatSync(filePath); } catch { throw probeError('RENDER_FAILED', '렌더 파일이 생성되지 않았습니다.'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) throw probeError('RENDER_FAILED', '렌더 결과 파일을 확인할 수 없습니다.');
  const args = ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate', '-of', 'json', filePath];
  const text = await captureProcess(spawn, ffprobePath, args, timeoutMs, signal);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw probeError('RENDER_FAILED', 'ffprobe 결과를 읽을 수 없습니다.'); }
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  const duration = Number(parsed.format?.duration);
  const fps = parseRate(video?.avg_frame_rate || video?.r_frame_rate);
  const formatNames = String(parsed.format?.format_name || '').split(',');
  const checks = {
    format_mp4: formatNames.includes('mp4'),
    resolution: video?.width === CREATOR_VIDEO_PROFILE.width && video?.height === CREATOR_VIDEO_PROFILE.height,
    duration: Number.isFinite(duration) && duration >= CREATOR_VIDEO_PROFILE.minimumSeconds && duration < CREATOR_VIDEO_PROFILE.maximumSecondsExclusive,
    video_codec: video?.codec_name === 'h264',
    audio_codec: audio?.codec_name === 'aac',
    frame_rate: Math.abs(fps - CREATOR_VIDEO_PROFILE.framesPerSecond) < 0.01,
  };
  if (Object.values(checks).some((passed) => !passed)) throw probeError('RENDER_VALIDATION_FAILED', '렌더 결과가 해주미 출력 규격을 만족하지 않습니다.');
  return { valid: true, ...checks, width: video.width, height: video.height, fps, duration_seconds: duration, video_codec: video.codec_name, audio_codec: audio.codec_name, format: 'mp4' };
}

function parseRate(value) {
  if (typeof value !== 'string') return Number.NaN;
  const [numerator, denominator] = value.split('/').map(Number);
  return denominator ? numerator / denominator : Number.NaN;
}

function captureProcess(spawn, executable, args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { reject(probeError('FFPROBE_UNAVAILABLE', 'ffprobe를 실행할 수 없습니다.')); return; }
    let stdout = '';
    const timer = setTimeout(() => { child.kill(); reject(probeError('FFPROBE_UNAVAILABLE', 'ffprobe 검증 시간이 초과되었습니다.')); }, timeoutMs);
    const onAbort = () => { child.kill(); reject(probeError('JOB_CANCELLED', '렌더 작업이 취소되었습니다.')); };
    if (signal?.aborted) { clearTimeout(timer); onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.stdout?.on('data', (chunk) => { if (stdout.length < 64 * 1024) stdout += chunk.toString().slice(0, 64 * 1024 - stdout.length); });
    child.once('error', () => { cleanup(); reject(probeError('FFPROBE_UNAVAILABLE', 'ffprobe를 실행할 수 없습니다.')); });
    child.once('close', (code) => {
      cleanup();
      if (code === 0) resolve(stdout);
      else reject(probeError('RENDER_VALIDATION_FAILED', 'ffprobe가 렌더 결과를 검증하지 못했습니다.'));
    });
  });
}

function probeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = code === 'FFPROBE_UNAVAILABLE' ? 503 : 422;
  return error;
}
