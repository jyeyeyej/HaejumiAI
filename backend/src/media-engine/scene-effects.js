import { videoFilter } from './video-profile.js';

export const SCENE_FRAMING = Object.freeze(['inherit', 'fit_pad', 'fill_crop', 'blur_pad']);
export const SCENE_MOTION = Object.freeze(['static', 'zoom_in', 'zoom_out', 'pan_left', 'pan_right']);
export const SCENE_TRANSITION = Object.freeze(['cut', 'fade']);
export const SUBTITLE_STYLES = Object.freeze(['default', 'emphasis', 'information']);

export function validSceneEffects(scene) {
  return (!scene.framing || SCENE_FRAMING.includes(scene.framing)) &&
    (!scene.motion || SCENE_MOTION.includes(scene.motion)) &&
    (!scene.transition || SCENE_TRANSITION.includes(scene.transition)) &&
    (!scene.subtitle_style || SUBTITLE_STYLES.includes(scene.subtitle_style)) &&
    (scene.bgm_mood === undefined || typeof scene.bgm_mood === 'string' && scene.bgm_mood.length <= 100) &&
    (scene.edit_reason === undefined || typeof scene.edit_reason === 'string' && scene.edit_reason.length <= 500);
}

/** Creates only allowlisted FFmpeg expressions. No user text reaches filter syntax. */
export function sceneVideoFilters(index, baseOptions, scene, duration, kind = 'image') {
  const framing = scene?.framing && scene.framing !== 'inherit' ? scene.framing : baseOptions.framing;
  const motion = scene?.motion ?? 'static';
  const transition = scene?.transition ?? 'cut';
  if (!SCENE_FRAMING.includes(framing) || !SCENE_MOTION.includes(motion) || !SCENE_TRANSITION.includes(transition)) throw new Error('Invalid scene effect');
  const normalized = `n${index}`;
  const filters = [];
  if (framing === 'blur_pad') {
    filters.push(`[${index}:v]split=2[bg${index}][fg${index}]`);
    filters.push(`[bg${index}]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:1[blur${index}]`);
    filters.push(`[fg${index}]scale=1080:1920:force_original_aspect_ratio=decrease[front${index}]`);
    filters.push(`[blur${index}][front${index}]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p[${normalized}]`);
  } else filters.push(`[${index}:v]${videoFilter({ ...baseOptions, framing })}[${normalized}]`);
  let source = `[${normalized}]`;
  if (motion !== 'static') {
    const frames = Math.max(1, Math.round(duration * 30));
    const zoom = motion === 'zoom_in' ? `min(1+0.12*on/${frames},1.12)` :
      motion === 'zoom_out' ? `max(1.12-0.12*on/${frames},1)` : '1.12';
    const x = motion === 'pan_left' ? `(iw-iw/zoom)*(1-on/${frames})` : motion === 'pan_right' ? `(iw-iw/zoom)*on/${frames}` : '(iw-iw/zoom)/2';
    filters.push(`${source}zoompan=z='${zoom}':x='${x}':y='(ih-ih/zoom)/2':d=1:s=1080x1920:fps=30[m${index}]`);
    source = `[m${index}]`;
  }
  const fadeSeconds = Math.min(0.35, duration / 4);
  const fade = transition === 'fade' ? `,fade=t=in:st=0:d=${fadeSeconds.toFixed(3)},fade=t=out:st=${(duration - fadeSeconds).toFixed(3)}:d=${fadeSeconds.toFixed(3)}` : '';
  const pad = kind === 'video' ? `,tpad=stop_mode=clone:stop_duration=${duration.toFixed(6)},trim=duration=${duration.toFixed(6)}` : '';
  filters.push(`${source}trim=duration=${duration.toFixed(6)}${pad},setpts=PTS-STARTPTS${fade}[v${index}]`);
  return filters;
}
