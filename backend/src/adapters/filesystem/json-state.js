import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const EMPTY = { uploads: {}, media: {}, projects: {}, tasks: {}, checkpoints: {}, approvals: {}, publications: {}, jobs: {}, idempotency: {}, llmBudget: {} };

export class JsonState {
  constructor(filePath) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    try {
      const info = lstatSync(filePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('State path must be a regular file.');
      this.data = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = structuredClone(EMPTY);
      this.save();
    }
    for (const key of Object.keys(EMPTY)) this.data[key] ??= {};
  }

  save() {
    try {
      const targetInfo = lstatSync(this.filePath);
      if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) throw new Error('State path must be a regular file.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data), { flag: 'wx', mode: 0o600 });
    try { renameSync(temporary, this.filePath); }
    finally {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
