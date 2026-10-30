import { spawn } from 'node:child_process';

/** Locally decodes, scales, and strips metadata before selected images leave the PC. */
export function createFFmpegImagePreparer({ ffmpegPath = 'ffmpeg', timeoutMs = 12_000, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  return async function prepareImage(path) {
    const args = ['-v', 'error', '-i', path, '-map_metadata', '-1', '-vf', 'scale=1024:1024:force_original_aspect_ratio=decrease', '-frames:v', '1', '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'];
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = []; let size = 0;
      const timer = setTimeout(() => { child.kill(); reject(new Error('Local image preparation timed out.')); }, timeoutMs);
      child.stdout.on('data', (chunk) => { size += chunk.length; if (size > maxOutputBytes) child.kill(); else chunks.push(chunk); });
      child.once('error', () => { clearTimeout(timer); reject(new Error('Local image preparation is unavailable.')); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || !chunks.length || size > maxOutputBytes) reject(new Error('Local image preparation failed.'));
        else resolve(Buffer.concat(chunks));
      });
    });
  };
}
