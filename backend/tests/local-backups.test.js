import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { LocalBackups } from '../src/adapters/filesystem/local-backups.js';

test('backup verifies hashes and restores to a separate copy without touching live data', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new JsonState(join(dir, 'state.json'));
  state.data.scheduleEvents = { one: { owner_id: 'a', title: '합성 일정' } }; state.save();
  const backups = new LocalBackups(dir);
  const created = backups.create('a');
  const live = readFileSync(join(dir, 'state.json'));
  assert.throws(() => backups.restoreCopy('b', created.backup_id), { code: 'RESOURCE_NOT_FOUND' });
  const restored = backups.restoreCopy('a', created.backup_id);
  assert.equal(restored.status, 'recovered_copy');
  assert.deepEqual(readFileSync(join(dir, 'state.json')), live);
  assert.deepEqual(readFileSync(join(dir, 'recovered', restored.restore_id, 'state.json')), live);
  writeFileSync(join(dir, 'backups', created.backup_id, 'state.json'), '{}');
  assert.throws(() => backups.restoreCopy('a', created.backup_id), { code: 'INVALID_BACKUP' });
  assert.deepEqual(readFileSync(join(dir, 'state.json')), live);
});
