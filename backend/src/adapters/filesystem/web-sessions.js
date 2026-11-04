import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const WEB_SESSION_SECONDS = 30 * 24 * 60 * 60;

export class WebSessions {
  constructor(filePath, bearerToken, ownerId, { now = () => Date.now(), lifetimeSeconds = WEB_SESSION_SECONDS, secureCookie = false } = {}) {
    this.filePath = filePath;
    this.tokenDigest = digest(bearerToken);
    this.ownerId = ownerId;
    this.now = now;
    this.lifetimeSeconds = lifetimeSeconds;
    this.secureCookie = secureCookie;
    this.sessions = this.read();
  }

  read() {
    try {
      const info = lstatSync(this.filePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Web session path must be a regular file.');
      const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!data || data.version !== 1 || typeof data.sessions !== 'object' || Array.isArray(data.sessions)) throw new Error('Invalid web session state.');
      return data.sessions;
    } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  save() {
    try { const info = lstatSync(this.filePath); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Web session path must be a regular file.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, sessions: this.sessions }), { flag: 'wx', mode: 0o600 });
    try { renameSync(temporary, this.filePath); }
    finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }

  create() {
    const id = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.lifetimeSeconds * 1000;
    this.sessions[digest(id)] = { ownerId: this.ownerId, tokenDigest: this.tokenDigest, expiresAt };
    this.save();
    return { id, expiresAt };
  }

  authenticate(id) {
    if (!ID_PATTERN.test(id ?? '')) return null;
    const record = this.sessions[digest(id)];
    if (!record || record.ownerId !== this.ownerId || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= this.now() ||
        typeof record.tokenDigest !== 'string' || record.tokenDigest.length !== this.tokenDigest.length ||
        !timingSafeEqual(Buffer.from(record.tokenDigest), Buffer.from(this.tokenDigest))) return null;
    return { ownerId: this.ownerId, scopes: ['creator:media:write', 'creator:project:write', 'creator:task:read'] };
  }

  revoke(id) {
    if (!ID_PATTERN.test(id ?? '')) return;
    if (Object.hasOwn(this.sessions, digest(id))) { delete this.sessions[digest(id)]; this.save(); }
  }
}
