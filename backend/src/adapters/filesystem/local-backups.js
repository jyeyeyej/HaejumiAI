import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FOLDERS = ['media', 'music', 'renders', 'uploads'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fault = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const regular = (path) => { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink()) fault(422, 'INVALID_BACKUP'); return readFileSync(path); };

export class LocalBackups {
  constructor(dataDir) { this.dataDir = dataDir; }

  create(ownerId) {
    const backupId = randomUUID();
    const backupsRoot = join(this.dataDir, 'backups');
    mkdirSync(backupsRoot, { recursive: true, mode: 0o700 });
    if (lstatSync(backupsRoot).isSymbolicLink()) fault(422, 'INVALID_BACKUP');
    const root = join(backupsRoot, backupId);
    mkdirSync(root, { mode: 0o700 });
    const files = [];
    const copy = (relative) => {
      const bytes = regular(join(this.dataDir, relative));
      const destination = join(root, relative);
      mkdirSync(join(destination, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
      files.push({ path: relative.replaceAll('\\', '/'), sha256: hash(bytes), size_bytes: bytes.length });
    };
    copy('state.json');
    for (const folder of FOLDERS) {
      let children;
      try { children = readdirSync(join(this.dataDir, folder)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const folderInfo = lstatSync(join(this.dataDir, folder));
      if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) fault(422, 'INVALID_BACKUP');
      for (const name of children) {
        if (!/^[a-zA-Z0-9._-]+$/.test(name) || name === '.' || name === '..') fault(422, 'INVALID_BACKUP');
        copy(join(folder, name));
      }
    }
    const manifest = { backup_id: backupId, owner_id: ownerId, created_at: new Date().toISOString(), files };
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    return { backup_id: backupId, created_at: manifest.created_at, file_count: files.length, status: 'verified_snapshot' };
  }

  restoreCopy(ownerId, backupId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(backupId)) fault(404, 'RESOURCE_NOT_FOUND');
    const root = join(this.dataDir, 'backups', backupId);
    try {
      for (const directory of [join(this.dataDir, 'backups'), root]) {
        const info = lstatSync(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) fault(422, 'INVALID_BACKUP');
      }
    } catch (error) { if (error.code === 'ENOENT') fault(404, 'RESOURCE_NOT_FOUND'); throw error; }
    let manifest;
    try { manifest = JSON.parse(regular(join(root, 'manifest.json')).toString('utf8')); }
    catch (error) { if (error.code === 'ENOENT') fault(404, 'RESOURCE_NOT_FOUND'); throw error; }
    if (manifest.owner_id !== ownerId || manifest.backup_id !== backupId) fault(404, 'RESOURCE_NOT_FOUND');
    if (!Array.isArray(manifest.files) || !manifest.files.some((f) => f.path === 'state.json')) fault(422, 'INVALID_BACKUP');
    const validated = manifest.files.map((file) => {
      if (typeof file.path !== 'string' || !/^(state\.json|(?:media|music|renders|uploads)\/[a-zA-Z0-9._-]+)$/.test(file.path) ||
          file.path.split('/').some((part) => part === '.' || part === '..') ||
          !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size_bytes)) fault(422, 'INVALID_BACKUP');
      const bytes = regular(join(root, file.path));
      if (bytes.length !== file.size_bytes || hash(bytes) !== file.sha256) fault(422, 'INVALID_BACKUP');
      return { path: file.path, bytes };
    });
    if (new Set(validated.map((f) => f.path)).size !== validated.length) fault(422, 'INVALID_BACKUP');
    try { JSON.parse(validated.find((f) => f.path === 'state.json').bytes.toString('utf8')); }
    catch { fault(422, 'INVALID_BACKUP'); }
    const restoreId = randomUUID();
    const target = join(this.dataDir, 'recovered', restoreId);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const file of validated) {
      const destination = join(target, file.path);
      mkdirSync(join(destination, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(destination, file.bytes, { flag: 'wx', mode: 0o600 });
    }
    return { restore_id: restoreId, backup_id: backupId, file_count: validated.length, status: 'recovered_copy',
      notice: '기존 데이터는 변경되지 않았습니다. 복구 사본을 검토한 뒤 별도 절차로 활성화하세요.' };
  }
}
