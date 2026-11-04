import { lstatSync, readdirSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

const executable = (path) => {
  try { const info = lstatSync(path); return info.isFile() && !info.isSymbolicLink(); }
  catch { return false; }
};

function findTool(name, configured, env) {
  if (configured) {
    const path = resolve(configured);
    if (!executable(path)) throw new Error(`${name} configured path is not a regular file.`);
    return path;
  }
  const filename = process.platform === 'win32' ? `${name}.exe` : name;
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const path = join(directory, filename);
    if (executable(path)) return path;
  }
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    const packages = join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    let names = [];
    try { names = readdirSync(packages).filter((entry) => /^Gyan\.FFmpeg\./.test(entry)); } catch { /* No WinGet package. */ }
    for (const packageName of names) {
      const packageRoot = join(packages, packageName);
      let builds = [];
      try { builds = readdirSync(packageRoot).filter((entry) => /^ffmpeg-[\w.+-]+$/.test(entry)); } catch { continue; }
      for (const build of builds) {
        const path = join(packageRoot, build, 'bin', filename);
        if (executable(path)) return path;
      }
    }
  }
  throw new Error(`${name} executable is unavailable. Set HAEJUMI_${name.toUpperCase()}_PATH to an installed local executable.`);
}

export function resolveMediaToolPaths(env = process.env) {
  return { ffmpegPath: findTool('ffmpeg', env.HAEJUMI_FFMPEG_PATH, env),
    ffprobePath: findTool('ffprobe', env.HAEJUMI_FFPROBE_PATH, env) };
}
