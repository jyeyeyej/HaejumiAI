import { spawn } from 'node:child_process';

/** Extracts one low-resolution frame from each user-selected video, entirely locally. */
export function createFFmpegFrameExtractor({ ffmpegPath = 'ffmpeg', timeoutMs = 15_000 } = {}) {
  return async function extractFrame(path) {
    const args = ['-v', 'error', '-i', path, '-vf', 'thumbnail,scale=768:-2', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'];
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = []; let size = 0;
      const timer = setTimeout(() => { child.kill(); reject(new Error('Local frame extraction timed out.')); }, timeoutMs);
      child.stdout.on('data', (chunk) => { size += chunk.length; if (size > 2 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || !chunks.length || size > 2 * 1024 * 1024) reject(new Error('Local frame extraction failed.'));
        else resolve(Buffer.concat(chunks));
      });
    });
  };
}
