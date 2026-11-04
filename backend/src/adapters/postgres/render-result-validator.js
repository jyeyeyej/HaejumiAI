import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';

export function validateCreatorRenderResult(result, renderDir) {
  if (!result || !['ffmpeg', 'test'].includes(result.mode)) {
    throw new Error('RENDER_FAILED');
  }

  const fileName = result.file_name;

  if (
    typeof fileName !== 'string' ||
    !fileName ||
    fileName !== basename(fileName) ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('\\') ||
    fileName.includes('/')
  ) {
    throw new Error('RENDER_FAILED');
  }

  const root = resolve(renderDir);
  const artifactPath = resolve(root, fileName);

  if (!artifactPath.startsWith(root + sep)) {
    throw new Error('RENDER_FAILED');
  }

  if (artifactPath !== resolve(result.output_path)) {
    throw new Error('RENDER_FAILED');
  }

  const info = lstatSync(artifactPath);

  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('RENDER_FAILED');
  }

  if (
    result.mode === 'ffmpeg' &&
    (result.verified !== true || result.verification?.valid !== true)
  ) {
    throw new Error('RENDER_VALIDATION_FAILED');
  }

  const bytes = readFileSync(artifactPath);

  return {
    status: result.mode === 'test' ? 'simulated' : 'succeeded',
    renderer_mode: result.mode,
    artifact_sha256: createHash('sha256').update(bytes).digest('hex'),
    artifact_key: fileName,
    artifact_verified: result.mode === 'ffmpeg' && result.verified === true,
    preview_ready: true,
    progress_percent: 100
  };
}