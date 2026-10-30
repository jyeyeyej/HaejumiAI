import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function ensureStorageDirectory(path, parentRoot = null) {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const info = lstatSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Storage path must be a real directory.');
  const real = realpathSync(absolute);
  if (parentRoot && !isWithin(parentRoot, real)) throw new Error('Storage directory escaped its configured root.');
  return real;
}

export function safeStoragePath(root, ...segments) {
  const normalizedRoot = resolve(root);
  if (segments.some((segment) => typeof segment !== 'string' || segment.length === 0 || isAbsolute(segment))) {
    throw new Error('Invalid storage path component.');
  }
  const candidate = resolve(normalizedRoot, ...segments);
  if (!isWithin(normalizedRoot, candidate)) throw new Error('Storage path escaped its root.');
  return candidate;
}

function isWithin(root, candidate) {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === '' || relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}
