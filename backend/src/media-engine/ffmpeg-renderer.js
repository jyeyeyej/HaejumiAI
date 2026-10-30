import { spawn as nodeSpawn } from 'node:child_process';
import { lstatSync, unlinkSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureStorageDirectory, safeStoragePath } from '../security/storage-paths.js';
import { captionSafeArea, validateRenderOptions, videoFilter } from './video-profile.js';
import { inspectRenderedVideo } from './ffprobe-validator.js';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime']);

/**
 * Replaceable local renderer. Inputs are opaque storage keys under mediaRoot;
 * only the backend should call this after checking user ownership and approval state.
 */
export function createFFmpegRenderer({ mediaRoot, outputRoot, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', spawn = nodeSpawn, timeoutMs = 15 * 60_000 }) {
  const safeMediaRoot = ensureStorageDirectory(resolve(mediaRoot));
  const safeOutputRoot = ensureStorageDirectory(resolve(outputRoot));

  return {
    async render({ mediaItems, targetSeconds = 30, framing = 'fit_pad', focalX = 0.5, focalY = 0.5, projectId = randomUUID(), version = 1, signal }) {
      const options = validateRenderOptions({ targetSeconds, framing, focalX, focalY });
      if (!Array.isArray(mediaItems) || mediaItems.length < 1 || mediaItems.length > 30) throw renderError('VALIDATION_ERROR', '선택 미디어는 1~30개여야 합니다.');
      if (!/^[0-9a-f-]{36}$/i.test(projectId) || !Number.isSafeInteger(version) || version < 1) throw renderError('VALIDATION_ERROR', '프로젝트 ID 또는 버전을 확인해 주세요.');

      const inputs = mediaItems.map((item) => resolveInput(safeMediaRoot, item));
      const outputName = `${projectId}-v${version}-${randomUUID()}.mp4`;
      const outputPath = safeStoragePath(safeOutputRoot, outputName);
      const args = buildRenderArgs(inputs, outputPath, options);
      try {
        await runProcess(spawn, ffmpegPath, args, timeoutMs, 'RENDER_FAILED', signal);
        if (signal?.aborted) throw renderError('JOB_CANCELLED', '렌더 작업이 취소되었습니다.');
        const verification = await inspectRenderedVideo({ spawn, ffprobePath, filePath: outputPath, timeoutMs, signal });
        return {
          mode: 'ffmpeg',
          output_path: outputPath,
          file_name: basename(outputPath),
          content_type: 'video/mp4',
          profile: { width: 1080, height: 1920, fps: 30, video_codec: 'h264', audio_codec: 'aac', duration_seconds: verification.duration_seconds },
          framing: options.framing,
          caption_safe_area: captionSafeArea(),
          verification,
          verified: true,
        };
      } catch (error) {
        removePartialOutput(outputPath);
        throw error;
      }
    },
  };
}

export function buildRenderArgs(inputs, outputPath, options) {
  const normalized = validateRenderOptions(options);
  if (!Array.isArray(inputs) || inputs.length < 1) throw renderError('VALIDATION_ERROR', '렌더 입력이 없습니다.');
  const secondsPerInput = normalized.targetSeconds / inputs.length;
  const args = ['-hide_banner', '-nostdin', '-y'];
  for (const input of inputs) {
    if (input.kind === 'image') args.push('-loop', '1', '-framerate', '30', '-t', String(secondsPerInput));
    args.push('-i', input.path);
  }
  const audioIndex = inputs.length;
  args.push('-f', 'lavfi', '-t', String(normalized.targetSeconds), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  const filters = [];
  const labels = [];
  const fit = videoFilter(normalized);
  inputs.forEach((input, index) => {
    const label = `v${index}`;
    const duration = secondsPerInput.toFixed(6);
    const tail = input.kind === 'video' ? `,tpad=stop_mode=clone:stop_duration=${duration}` : '';
    filters.push(`[${index}:v]${fit},trim=duration=${duration}${tail},trim=duration=${duration},setpts=PTS-STARTPTS[${label}]`);
    labels.push(`[${label}]`);
  });
  filters.push(`${labels.join('')}concat=n=${inputs.length}:v=1:a=0[vout]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', `${audioIndex}:a:0`, '-t', String(normalized.targetSeconds),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-r', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', '-f', 'mp4', outputPath);
  return args;
}

function resolveInput(mediaRoot, item) {
  if (!item || (!IMAGE_TYPES.has(item.mediaType) && !VIDEO_TYPES.has(item.mediaType)) || typeof item.storageKey !== 'string' || item.storageKey !== basename(item.storageKey)) {
    throw renderError('VALIDATION_ERROR', '렌더 미디어 형식 또는 저장 참조를 확인해 주세요.');
  }
  const filePath = safeStoragePath(mediaRoot, item.storageKey);
  let info;
  try { info = lstatSync(filePath); } catch { throw renderError('RESOURCE_NOT_FOUND', '렌더 미디어를 찾을 수 없습니다.'); }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1) throw renderError('VALIDATION_ERROR', '렌더 입력 파일을 안전하게 읽을 수 없습니다.');
  const kind = IMAGE_TYPES.has(item.mediaType) ? 'image' : 'video';
  const extension = extname(item.fileName || '').toLowerCase();
  const validExtensions = kind === 'image' ? ['.jpg', '.jpeg', '.png', '.webp'] : item.mediaType === 'video/mp4' ? ['.mp4'] : ['.mov', '.qt'];
  if (!validExtensions.includes(extension)) {
    throw renderError('UNSUPPORTED_MEDIA_TYPE', '미디어 형식과 파일명이 일치하지 않습니다.');
  }
  return { path: filePath, kind };
}

async function runProcess(spawn, executable, args, timeoutMs, errorCode, signal) {
  await new Promise((resolvePromise, reject) => {
    let child;
    try { child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch { reject(renderError(errorCode, '로컬 미디어 도구를 실행할 수 없습니다.')); return; }
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(renderError(errorCode, '로컬 미디어 작업 시간이 초과되었습니다.')); }, timeoutMs);
    const onAbort = () => { child.kill(); reject(renderError('JOB_CANCELLED', '렌더 작업이 취소되었습니다.')); };
    if (signal?.aborted) { clearTimeout(timer); onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.stderr?.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk.toString().slice(0, 4096 - stderr.length); });
    child.once('error', () => { cleanup(); reject(renderError(errorCode, '로컬 미디어 도구를 실행할 수 없습니다.')); });
    child.once('close', (code) => {
      cleanup();
      if (code === 0) resolvePromise();
      else reject(renderError(errorCode, '미디어 렌더 또는 검증에 실패했습니다.'));
    });
  });
}

function renderError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = code === 'RESOURCE_NOT_FOUND' ? 404 : code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : 422;
  return error;
}

function removePartialOutput(path) {
  try {
    const info = lstatSync(path);
    if (info.isFile() && !info.isSymbolicLink()) unlinkSync(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
