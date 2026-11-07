import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

export class EncryptedTokenVault {
  constructor(filePath, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A separate 32-byte encryption key is required.');
    this.filePath = filePath;
    this.key = Buffer.from(key);
  }

  read() {
    let data;
    try {
      const info = lstatSync(this.filePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Token vault path must be a regular file.');
      data = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    if (data.version !== 1 || typeof data.entries !== 'object' || !data.entries) throw new Error('Invalid token vault.');
    return data.entries;
  }

  get(owner) {
    const item = this.read()[owner];
    if (!item) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(item.iv, 'base64'));
      decipher.setAAD(Buffer.from(owner));
      decipher.setAuthTag(Buffer.from(item.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(item.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    } catch { throw new Error('Token vault decryption failed.'); }
  }

  set(owner, value) {
    const entries = this.read();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(owner));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    entries[owner] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    this.write(entries);
  }

  delete(owner) {
    const entries = this.read();
    if (!Object.hasOwn(entries, owner)) return;
    delete entries[owner];
    this.write(entries);
  }

  write(entries) {
    try {
      const info = lstatSync(this.filePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Token vault path must be a regular file.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temp = this.filePath + '.' + randomBytes(8).toString('hex') + '.tmp';
    writeFileSync(temp, JSON.stringify({ version: 1, entries }), { flag: 'wx', mode: 0o600 });
    try { renameSync(temp, this.filePath); }
    finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
}
