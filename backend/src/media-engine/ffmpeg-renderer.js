import { spawn as nodeSpawn } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensureStorageDirectory, safeStoragePath } from '../security/storage-paths.js';
import { captionSafeArea, validateRenderOptions } from './video-profile.js';
import { sceneVideoFilters, validSceneEffects } from './scene-effects.js';
import { inspectRenderedVideo } from './ffprobe-validator.js';
import { CAPTION_FONT_SHA256, CAPTION_TEXT_PATTERN } from './caption-font.js';
import { sha256 } from '../security/media-validation.js';
import { captionScene, validCaptionTimeline } from './caption-timeline.js';

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
    async render({ mediaItems, targetSeconds = 30, framing = 'fit_pad', focalX = 0.5, focalY = 0.5, projectId = randomUUID(), version = 1, signal, captions = [], composition = null, musicPath = null, reuseVideo = null, scenes = null }) {
      const options = validateRenderOptions({ targetSeconds, framing, focalX, focalY });
      if (!Array.isArray(mediaItems) || mediaItems.length < 1 || mediaItems.length > 30) throw renderError('VALIDATION_ERROR', '선택 미디어는 1~30개여야 합니다.');
      if (!/^[0-9a-f-]{36}$/i.test(projectId) || !Number.isSafeInteger(version) || version < 1) throw renderError('VALIDATION_ERROR', '프로젝트 ID 또는 버전을 확인해 주세요.');

      const inputs = mediaItems.map((item) => ({ ...resolveInput(safeMediaRoot, item), mediaId: item.mediaId, mediaType: item.mediaType }));
      const timeline = validatedTimeline(inputs, scenes, targetSeconds);
      const outputName = `${projectId}-v${version}-${randomUUID()}.mp4`;
      const outputPath = safeStoragePath(safeOutputRoot, outputName);
      let temporaryDir = null;
      const temporaryFiles = [];
      try {
        if (musicPath) {
          const musicRoot = resolve(safeOutputRoot, '..', 'music');
          if (resolve(musicPath) !== safeStoragePath(musicRoot, basename(musicPath))) throw renderError('VALIDATION_ERROR', '음원 저장 경로를 확인해 주세요.');
          const info = lstatSync(musicPath);
          if (!info.isFile() || info.isSymbolicLink()) throw renderError('VALIDATION_ERROR', '음원 파일을 확인해 주세요.');
        }
        if (composition) {
          for (const input of inputs) input.hasAudio = input.kind === 'video' ? await hasAudioStream(spawn, ffprobePath, input.path, timeoutMs, signal) : false;
          if (inputs.some((input) => input.hasAudio && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.mediaId ?? ''))) throw renderError('VALIDATION_ERROR', '원본 오디오의 미디어 참조를 확인해 주세요.');
        }
        if (reuseVideo) {
          if (!composition || resolve(reuseVideo.path) !== safeStoragePath(safeOutputRoot, basename(reuseVideo.path)) || !/^[a-f\d]{64}$/.test(reuseVideo.sha256 ?? '')) throw renderError('VALIDATION_ERROR', '이전 렌더 참조를 확인해 주세요.');
          const info = lstatSync(reuseVideo.path);
          if (!info.isFile() || info.isSymbolicLink() || sha256(readFileSync(reuseVideo.path)) !== reuseVideo.sha256) throw renderError('VERSION_CONFLICT', '이전 렌더 파일이 변경되었습니다.');
        }
        if (!reuseVideo) {
          for (const [index, input] of inputs.entries()) {
            if (input.mediaType !== 'image/jpeg' || !readFileSync(input.path).includes(Buffer.from('MPF\0', 'ascii'))) continue;
            // FFmpeg can stall at fps conversion when looping an MPF JPEG. Decode
            // its primary image once; keep the uploaded original untouched.
            if (!temporaryDir) {
              temporaryDir = safeStoragePath(safeOutputRoot, `caption-${randomUUID()}`);
              mkdirSync(temporaryDir, { mode: 0o700 });
            }
            const normalizedPath = join(temporaryDir, `media-${index}.png`);
            temporaryFiles.push(normalizedPath);
            await runProcess(spawn, ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', input.path,
              '-map', '0:v:0', '-frames:v', '1', '-an', '-c:v', 'png', normalizedPath],
              Math.min(timeoutMs, 60_000), 'RENDER_FAILED', signal);
            input.path = normalizedPath;
          }
        }
        if (captions.length && !reuseVideo) {
          if (!temporaryDir) {
            temporaryDir = safeStoragePath(safeOutputRoot, `caption-${randomUUID()}`);
            mkdirSync(temporaryDir, { mode: 0o700 });
          }
          const font = fileURLToPath(new URL('../../assets/fonts/NotoSansKR-Regular.otf', import.meta.url));
          copyFileSync(font, join(temporaryDir, 'NotoSansKR-Regular.otf'), constants.COPYFILE_EXCL);
          if (sha256(readFileSync(join(temporaryDir, 'NotoSansKR-Regular.otf'))) !== CAPTION_FONT_SHA256) throw renderError('VALIDATION_ERROR', '자막 글꼴의 무결성을 확인할 수 없습니다.');
          writeFileSync(join(temporaryDir, 'captions.ass'), buildAss(captions, targetSeconds, scenes), { flag: 'wx', mode: 0o600 });
        }
        const args = reuseVideo ? buildAudioReuseArgs(inputs, reuseVideo.path, outputPath, { ...options, composition, musicPath, timeline }) :
          buildRenderArgs(inputs, outputPath, { ...options, composition, musicPath, timeline, scenes, subtitleFile: captions.length ? 'captions.ass' : null });
        await runProcess(spawn, ffmpegPath, args, timeoutMs, 'RENDER_FAILED', signal, temporaryDir ?? undefined);
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
          video_reused: Boolean(reuseVideo),
          source_audio_media_ids: composition ? inputs.filter((input) => input.hasAudio).map((input) => input.mediaId).filter(Boolean) : [],
        };
      } catch (error) {
        removePartialOutput(outputPath);
        throw error;
      } finally {
        if (temporaryDir) {
          for (const path of [...temporaryFiles, join(temporaryDir, 'captions.ass'), join(temporaryDir, 'NotoSansKR-Regular.otf')]) {
            try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          rmdirSync(temporaryDir);
        }
      }
    },
  };
}

export function buildAudioReuseArgs(inputs, videoPath, outputPath, options) {
  const normalized = validateRenderOptions(options); const c = options.composition;
  if (!c || [c.source_volume, c.music_volume].some((v) => !Number.isFinite(v) || v < 0 || v > 2) ||
      [c.fade_in_seconds, c.fade_out_seconds].some((v) => !Number.isFinite(v) || v < 0 || v > 10 || v > normalized.targetSeconds / 2)) throw renderError('VALIDATION_ERROR', '오디오 설정을 확인해 주세요.');
  const args = ['-hide_banner', '-nostdin', '-y', '-i', videoPath]; let nextInput = 1;
  const indices = inputs.map((input, index) => { if (!input.hasAudio) return null; if (options.timeline?.[index].trimStart) args.push('-ss', String(options.timeline[index].trimStart));
    if (options.timeline?.[index].trimEnd !== undefined) args.push('-t', String(options.timeline[index].trimEnd - options.timeline[index].trimStart));
    args.push('-i', input.path); return nextInput++; });
  let musicIndex = null;
  if (options.musicPath) { musicIndex = nextInput++; args.push('-stream_loop', '-1', '-i', options.musicPath); }
  const filters = []; const labels = [];
  inputs.forEach((input, index) => {
    const source = indices[index] === null ? 'anullsrc=r=48000:cl=stereo' : `[${indices[index]}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad`;
    const segmentDuration = (options.timeline?.[index].duration ?? normalized.targetSeconds / inputs.length).toFixed(6);
    filters.push(`${source},atrim=duration=${segmentDuration},asetpts=PTS-STARTPTS[a${index}]`); labels.push(`[a${index}]`);
  });
  const fade = `${c.fade_in_seconds ? `,afade=t=in:st=0:d=${c.fade_in_seconds}` : ''}${c.fade_out_seconds ? `,afade=t=out:st=${normalized.targetSeconds - c.fade_out_seconds}:d=${c.fade_out_seconds}` : ''}`;
  filters.push(`${labels.join('')}concat=n=${inputs.length}:v=0:a=1,volume=${c.source_volume}${fade}[original]`);
  if (musicIndex !== null) {
    filters.push(`[${musicIndex}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${normalized.targetSeconds},asetpts=PTS-STARTPTS,volume=${c.music_volume}${fade}[music]`);
    filters.push('[original][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]');
  } else filters.push('[original]anull[aout]');
  args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[aout]', '-t', String(normalized.targetSeconds), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', '-f', 'mp4', outputPath);
  return args;
}


export function buildRenderArgs(inputs, outputPath, options) {
  const normalized = validateRenderOptions(options);
  if (!Array.isArray(inputs) || inputs.length < 1) throw renderError('VALIDATION_ERROR', '렌더 입력이 없습니다.');
  const secondsPerInput = normalized.targetSeconds / inputs.length;
  const args = ['-hide_banner', '-nostdin', '-y'];
  for (const [index, input] of inputs.entries()) {
    const segmentDuration = options.timeline?.[index].duration ?? secondsPerInput;
    // Decode a still once per second, then duplicate the scaled frame at the
    // output filter's 30 fps. One extra source second lets fps fill the last
    // (possibly fractional) scene second before the final trim.
    if (input.kind === 'image') args.push('-loop', '1', '-framerate', '1', '-t', String(Math.ceil(segmentDuration) + 1));
    if (input.kind === 'video' && options.timeline?.[index].trimStart) args.push('-ss', String(options.timeline[index].trimStart));
    if (input.kind === 'video' && options.timeline?.[index].trimEnd !== undefined) args.push('-t', String(options.timeline[index].trimEnd - options.timeline[index].trimStart));
    args.push('-i', input.path);
  }
  const audioIndex = inputs.length;
  if (!options.composition) args.push('-f', 'lavfi', '-t', String(normalized.targetSeconds), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  else if (options.musicPath) args.push('-stream_loop', '-1', '-i', options.musicPath);
  const filters = [];
  const labels = [];
  inputs.forEach((input, index) => {
    const label = `v${index}`;
    const duration = options.timeline?.[index].duration ?? secondsPerInput;
    filters.push(...sceneVideoFilters(index, normalized, options.scenes?.[index], duration, input.kind));
    labels.push(`[${label}]`);
  });
  filters.push(`${labels.join('')}concat=n=${inputs.length}:v=1:a=0[video]`);
  filters.push(options.subtitleFile ? `[video]subtitles=filename=${options.subtitleFile}:fontsdir=.[vout]` : '[video]null[vout]');
  let audioMap = `${audioIndex}:a:0`;
  if (options.composition) {
    const c = options.composition;
    if ([c.source_volume, c.music_volume].some((v) => !Number.isFinite(v) || v < 0 || v > 2) ||
        [c.fade_in_seconds, c.fade_out_seconds].some((v) => !Number.isFinite(v) || v < 0 || v > 10 || v > normalized.targetSeconds / 2)) throw renderError('VALIDATION_ERROR', '오디오 설정을 확인해 주세요.');
    const audioLabels = [];
    inputs.forEach((input, index) => {
      const label = `a${index}`; const duration = (options.timeline?.[index].duration ?? secondsPerInput).toFixed(6);
      const source = input.hasAudio ? `[${index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad` : 'anullsrc=r=48000:cl=stereo';
      filters.push(`${source},atrim=duration=${duration},asetpts=PTS-STARTPTS[${label}]`); audioLabels.push(`[${label}]`);
    });
    const fade = `${c.fade_in_seconds ? `,afade=t=in:st=0:d=${c.fade_in_seconds}` : ''}${c.fade_out_seconds ? `,afade=t=out:st=${normalized.targetSeconds - c.fade_out_seconds}:d=${c.fade_out_seconds}` : ''}`;
    filters.push(`${audioLabels.join('')}concat=n=${inputs.length}:v=0:a=1,volume=${c.source_volume}${fade}[original]`);
    if (options.musicPath) {
      filters.push(`[${audioIndex}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${normalized.targetSeconds},asetpts=PTS-STARTPTS,volume=${c.music_volume}${fade}[music]`);
      filters.push('[original][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]');
    } else filters.push('[original]anull[aout]');
    audioMap = '[aout]';
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', audioMap, '-t', String(normalized.targetSeconds),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-r', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', '-f', 'mp4', outputPath);
  return args;
}

function validatedTimeline(inputs, scenes, targetSeconds) {
  if (!scenes) return null;
  if (!Array.isArray(scenes) || scenes.length !== inputs.length) throw renderError('VALIDATION_ERROR', '장면 목록을 확인해 주세요.');
  let previousEnd = 0;
  const timeline = scenes.map((scene, index) => {
    if (!scene || scene.order !== index + 1 || scene.media_id !== inputs[index].mediaId || !validSceneEffects(scene) ||
        !Number.isFinite(scene.start_seconds) || !Number.isFinite(scene.end_seconds) ||
        Math.abs(scene.start_seconds - previousEnd) > 0.01 || scene.end_seconds <= scene.start_seconds ||
        scene.end_seconds > targetSeconds + 0.01 ||
        (scene.trim_start_seconds !== undefined && (inputs[index].kind !== 'video' || !Number.isFinite(scene.trim_start_seconds) ||
          scene.trim_start_seconds < 0 || scene.trim_start_seconds > 3600)) ||
        (scene.trim_end_seconds !== undefined && (inputs[index].kind !== 'video' || !Number.isFinite(scene.trim_end_seconds) ||
          scene.trim_end_seconds > 3600 || scene.trim_end_seconds - (scene.trim_start_seconds ?? 0) + 0.001 < scene.end_seconds - scene.start_seconds)))
      throw renderError('VALIDATION_ERROR', '장면 시간 또는 영상 구간을 확인해 주세요.');
    const duration = scene.end_seconds - scene.start_seconds;
    previousEnd = scene.end_seconds;
    return { duration, trimStart: scene.trim_start_seconds ?? 0, ...(scene.trim_end_seconds === undefined ? {} : { trimEnd: scene.trim_end_seconds }) };
  });
  if (Math.abs(previousEnd - targetSeconds) > 0.01) throw renderError('VALIDATION_ERROR', '장면 길이 합계가 목표 길이와 다릅니다.');
  return timeline;
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

export function buildAss(captions, duration, scenes = null) {
  if (!validCaptionTimeline(captions, scenes, duration)) throw renderError('VALIDATION_ERROR', '자막 문구와 장면별 시간을 확인해 주세요.');
  const stamp = (seconds) => {
    const centiseconds = Math.round(seconds * 100);
    const h = Math.floor(centiseconds / 360000); const m = Math.floor(centiseconds / 6000) % 60;
    const s = Math.floor(centiseconds / 100) % 60; const cs = centiseconds % 100;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };
  const lines = captions.map((c, index) => {
    if (!c || c.order !== index + 1 || !Number.isFinite(c.start_seconds) || !Number.isFinite(c.end_seconds) || c.start_seconds < 0 || c.start_seconds >= c.end_seconds || c.end_seconds > duration ||
        typeof c.text !== 'string' || [...c.text].length > 80 || !CAPTION_TEXT_PATTERN.test(c.text)) throw renderError('VALIDATION_ERROR', '자막 길이 또는 시간을 확인해 주세요.');
    const chars = [...c.text.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝')];
    const wrapped = []; for (let i = 0; i < chars.length; i += 20) wrapped.push(chars.slice(i, i + 20).join(''));
    const scene = captionScene(c, scenes);
    const style = scene?.subtitle_style === 'emphasis' ? 'Emphasis' : scene?.subtitle_style === 'information' ? 'Information' : 'Default';
    return `Dialogue: 0,${stamp(c.start_seconds)},${stamp(c.end_seconds)},${style},,0,0,0,,${wrapped.join('\\N')}`;
  });
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans KR,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,108,108,384,1\nStyle: Emphasis,Noto Sans KR,52,&H0000FFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,1,2,108,108,384,1\nStyle: Information,Noto Sans KR,38,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,8,108,108,320,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.join('\n')}\n`;
}

async function hasAudioStream(spawn, ffprobePath, filePath, timeoutMs, signal) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try { child = spawn(ffprobePath, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { reject(renderError('FFPROBE_UNAVAILABLE', '원본 오디오를 확인할 수 없습니다.')); return; }
    let output = ''; let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); error ? reject(error) : resolvePromise(value); };
    const onAbort = () => { child.kill(); finish(renderError('JOB_CANCELLED', '렌더 작업이 취소되었습니다.')); };
    const timer = setTimeout(() => { child.kill(); finish(renderError('FFPROBE_UNAVAILABLE', '원본 오디오 확인 시간이 초과되었습니다.')); }, timeoutMs);
    if (signal?.aborted) { onAbort(); return; } signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => { if (output.length < 1024) output += chunk.toString(); });
    child.once('error', () => finish(renderError('FFPROBE_UNAVAILABLE', '원본 오디오를 확인할 수 없습니다.')));
    child.once('close', (code) => {
      if (code !== 0 || (output.trim() && !/^\d+$/.test(output.trim()))) return finish(renderError('FFPROBE_UNAVAILABLE', '원본 오디오를 확인할 수 없습니다.'));
      return finish(null, Boolean(output.trim()));
    });
  });
}

async function runProcess(spawn, executable, args, timeoutMs, errorCode, signal, cwd) {
  await new Promise((resolvePromise, reject) => {
    let child;
    try { child = spawn(executable, args, { windowsHide: true, cwd, stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (cause) { const error = renderError(cause?.code === 'ENOENT' ? 'FFMPEG_UNAVAILABLE' : errorCode, '로컬 미디어 도구를 실행할 수 없습니다.'); error.failureStage = 'ffmpeg_start'; reject(error); return; }
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(renderError(errorCode, '로컬 미디어 작업 시간이 초과되었습니다.')); }, timeoutMs);
    const onAbort = () => { child.kill(); reject(renderError('JOB_CANCELLED', '렌더 작업이 취소되었습니다.')); };
    if (signal?.aborted) { clearTimeout(timer); onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.stderr?.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk.toString().slice(0, 4096 - stderr.length); });
    child.once('error', (cause) => { cleanup(); const error = renderError(cause?.code === 'ENOENT' ? 'FFMPEG_UNAVAILABLE' : errorCode, '로컬 미디어 도구를 실행할 수 없습니다.'); error.failureStage = 'ffmpeg_start'; reject(error); });
    child.once('close', (code) => {
      cleanup();
      if (code === 0) resolvePromise();
      else { const error = renderError(errorCode, '미디어 렌더 또는 검증에 실패했습니다.');
        error.failureStage = 'ffmpeg_encode'; error.exitCode = Number.isInteger(code) ? code : null;
        error.diagnosticCode = /No such file or directory/i.test(stderr) ? 'INPUT_UNAVAILABLE' :
          /Error initializing (?:output stream|complex filters)|Error reinitializing filters/i.test(stderr) ? 'FILTER_OR_ENCODER' :
          /Invalid data found when processing input|Could not find codec parameters/i.test(stderr) ? 'INPUT_FORMAT' : 'UNKNOWN';
        reject(error); }
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
