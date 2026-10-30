import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { safeStoragePath } from '../security/storage-paths.js';
import { validateRenderOptions } from './video-profile.js';

/** Lifecycle-only renderer for API tests. Its bytes are deliberately NOT an MP4. */
export function createTestRenderer({ outputRoot }) {
  return {
    async render({ mediaItems, targetSeconds = 30, framing = 'fit_pad', signal }) {
      validateRenderOptions({ targetSeconds, framing });
      if (signal?.aborted) throw cancelled();
      if (!Array.isArray(mediaItems) || mediaItems.length === 0) throw new Error('No authorized input media.');
      const fileName = `simulation-${randomUUID()}.preview-test`;
      const outputPath = safeStoragePath(outputRoot, fileName);
      writeFileSync(outputPath, Buffer.from('HAEJUMI TEST RENDER — NOT A VIDEO FILE', 'utf8'), { flag: 'wx', mode: 0o600 });
      return { mode: 'test', output_path: outputPath, file_name: fileName, verified: false, format: null };
    },
  };
}

function cancelled() { const error = new Error('Cancelled'); error.code = 'JOB_CANCELLED'; error.status = 409; return error; }
