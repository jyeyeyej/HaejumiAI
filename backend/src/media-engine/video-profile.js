export const CREATOR_VIDEO_PROFILE = Object.freeze({
  aspectRatio: '9:16',
  width: 1080,
  height: 1920,
  minimumSeconds: 3,
  maximumSecondsExclusive: 60,
  defaultSeconds: 30,
  videoFormat: 'mp4',
  videoCodec: 'h264',
  audioCodec: 'aac',
  framesPerSecond: 30,
});

// Conservative shared overlay bounds. Platform UI can change; callers may tighten these.
export const CREATOR_SAFE_AREA = Object.freeze({
  left: 108,
  right: 972,
  top: 288,
  bottom: 1536,
});

export function validateRenderOptions({ targetSeconds = CREATOR_VIDEO_PROFILE.defaultSeconds, framing = 'fit_pad', focalX = 0.5, focalY = 0.5 } = {}) {
  if (!Number.isInteger(targetSeconds) || targetSeconds < CREATOR_VIDEO_PROFILE.minimumSeconds || targetSeconds >= CREATOR_VIDEO_PROFILE.maximumSecondsExclusive) {
    throw renderError('VALIDATION_ERROR', '영상 길이는 3초 이상 60초 미만이어야 합니다.');
  }
  if (!['fit_pad', 'fill_crop'].includes(framing)) throw renderError('VALIDATION_ERROR', 'framing은 fit_pad 또는 fill_crop이어야 합니다.');
  if (!Number.isFinite(focalX) || focalX < 0 || focalX > 1 || !Number.isFinite(focalY) || focalY < 0 || focalY > 1) {
    throw renderError('VALIDATION_ERROR', 'focalX와 focalY는 0부터 1 사이여야 합니다.');
  }
  return { targetSeconds, framing, focalX, focalY };
}

export function videoFilter({ framing = 'fit_pad', focalX = 0.5, focalY = 0.5 } = {}) {
  const options = validateRenderOptions({ framing, focalX, focalY });
  if (options.framing === 'fit_pad') {
    return 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p';
  }
  return `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:x=(iw-ow)*${options.focalX}:y=(ih-oh)*${options.focalY},setsar=1,fps=30,format=yuv420p`;
}

export function captionSafeArea() {
  return { ...CREATOR_SAFE_AREA };
}

function renderError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 422;
  return error;
}
