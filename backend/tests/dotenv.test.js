import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv } from '../src/config/dotenv.js';

test('dotenv loader reads only allowlisted local settings without evaluating shell syntax', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-dotenv-'));
  const file = join(dir, '.env');
  writeFileSync(file, [
    'HAEJUMI_BIND_HOST="127.0.0.1"',
    'HAEJUMI_PORT=8765',
    'HAEJUMI_OWNER_ID=local-owner',
    'HAEJUMI_BEARER_TOKEN=synthetic-token-value-that-is-not-a-real-secret',
    'HAEJUMI_DATA_DIR=./data',
    'HAEJUMI_MAX_MEDIA_BYTES=52428800',
    'HAEJUMI_LLM_ENABLED=false',
    'HAEJUMI_OPENAI_LIVE_ENABLED=false',
    'HAEJUMI_LLM_DAILY_BUDGET_USD=0.20',
    'HAEJUMI_LLM_MONTHLY_BUDGET_USD=5',
    'HAEJUMI_LLM_MAX_CALLS_PER_TASK=5',
    'HAEJUMI_LLM_MAX_REVISIONS_PER_TASK=3',
    'HAEJUMI_OPENAI_API_KEY=synthetic-openai-key-never-for-network',
    'HAEJUMI_OPENAI_MODEL=gpt-test-model',
    'OPENAI_API_KEY=synthetic-alias-key-never-for-network',
    'OPENAI_MODEL=gpt-test-alias',
    'IGNORED_SETTING=$(Write-Host never-run)',
  ].join('\n'));
  const target = {};
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  loadDotEnv(file, target);
  assert.equal(target.HAEJUMI_BIND_HOST, '127.0.0.1');
  assert.equal(target.HAEJUMI_PORT, '8765');
  assert.equal(target.HAEJUMI_OWNER_ID, 'local-owner');
  assert.equal(target.HAEJUMI_DATA_DIR, './data');
  assert.equal(target.HAEJUMI_MAX_MEDIA_BYTES, '52428800');
  assert.equal(target.HAEJUMI_LLM_ENABLED, 'false');
  assert.equal(target.HAEJUMI_OPENAI_LIVE_ENABLED, 'false');
  assert.equal(target.HAEJUMI_LLM_DAILY_BUDGET_USD, '0.20');
  assert.equal(target.HAEJUMI_LLM_MONTHLY_BUDGET_USD, '5');
  assert.equal(target.HAEJUMI_LLM_MAX_CALLS_PER_TASK, '5');
  assert.equal(target.HAEJUMI_LLM_MAX_REVISIONS_PER_TASK, '3');
  assert.equal(target.HAEJUMI_OPENAI_MODEL, 'gpt-test-model');
  assert.equal(target.HAEJUMI_OPENAI_API_KEY, 'synthetic-openai-key-never-for-network');
  assert.equal(target.OPENAI_API_KEY, 'synthetic-alias-key-never-for-network');
  assert.equal(Object.hasOwn(target, 'IGNORED_SETTING'), false);
  assert.equal(target.HAEJUMI_BEARER_TOKEN.length >= 32, true);
});

test('existing process environment wins and duplicate settings are rejected', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-dotenv-'));
  const file = join(dir, '.env');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(file, 'HAEJUMI_OWNER_ID=file-owner\n');
  const target = { HAEJUMI_OWNER_ID: 'process-owner' };
  loadDotEnv(file, target);
  assert.equal(target.HAEJUMI_OWNER_ID, 'process-owner');
  writeFileSync(file, 'HAEJUMI_OWNER_ID=first\nHAEJUMI_OWNER_ID=second\n');
  assert.throws(() => loadDotEnv(file, {}), /Duplicate \.env setting/);
});
