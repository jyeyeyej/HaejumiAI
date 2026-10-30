import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SETTINGS = new Set([
  'HAEJUMI_BIND_HOST', 'HAEJUMI_PORT', 'HAEJUMI_OWNER_ID',
  'HAEJUMI_BEARER_TOKEN', 'HAEJUMI_DATA_DIR', 'HAEJUMI_MAX_MEDIA_BYTES',
]);

/** Load only supported Haejumi keys. Existing process environment wins. */
export function loadDotEnv(filePath, target = process.env) {
  const absolute = resolve(filePath);
  let fileInfo;
  try { fileInfo = lstatSync(absolute); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('The local .env must be a regular non-symlink file.');

  const seen = new Set();
  const source = readFileSync(absolute, 'utf8');
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid .env syntax at line ${index + 1}.`);
    const [, name] = match;
    if (!SETTINGS.has(name)) continue;
    if (seen.has(name)) throw new Error(`Duplicate .env setting at line ${index + 1}.`);
    seen.add(name);
    const value = parseValue(match[2], index + 1);
    if (target[name] === undefined) target[name] = value;
  }
}

function parseValue(raw, lineNumber) {
  const value = raw.trim();
  if (!value) return '';
  const first = value[0];
  if (first === '"' || first === "'") {
    if (value.length < 2 || value[value.length - 1] !== first) throw new Error(`Unclosed .env value at line ${lineNumber}.`);
    return value.slice(1, -1);
  }
  if (value.includes('"') || value.includes("'")) throw new Error(`Invalid quote in .env value at line ${lineNumber}.`);
  return value;
}
