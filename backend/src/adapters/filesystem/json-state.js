import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = { uploads: {}, media: {}, projects: {}, tasks: {}, idempotency: {} };

export class JsonState {
  constructor(filePath) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    try {
      this.data = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = structuredClone(EMPTY);
      this.save();
    }
    for (const key of Object.keys(EMPTY)) this.data[key] ??= {};
  }

  save() {
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}
