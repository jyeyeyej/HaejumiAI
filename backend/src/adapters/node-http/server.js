import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve, join } from 'node:path';
import { JsonState } from '../filesystem/json-state.js';
import { LocalRepositories } from '../filesystem/repositories.js';
import { createApiHandler } from './transport.js';

const host = process.env.HAEJUMI_BIND_HOST || '127.0.0.1';
if (host !== '127.0.0.1') throw new Error('The reference server must bind to 127.0.0.1 only.');
const token = process.env.HAEJUMI_BEARER_TOKEN;
const ownerId = process.env.HAEJUMI_OWNER_ID;
if (!token || token.length < 32 || token.includes('replace-with-')) {
  throw new Error('Set HAEJUMI_BEARER_TOKEN to a locally generated secret of at least 32 characters.');
}
if (!ownerId) throw new Error('Set HAEJUMI_OWNER_ID before starting the server.');

const dataDir = resolve(process.env.HAEJUMI_DATA_DIR || './data');
const maxMediaBytes = Number(process.env.HAEJUMI_MAX_MEDIA_BYTES || 52_428_800);
if (!Number.isSafeInteger(maxMediaBytes) || maxMediaBytes < 1) throw new Error('Invalid HAEJUMI_MAX_MEDIA_BYTES.');

const state = new JsonState(join(dataDir, 'state.json'));
const repositories = new LocalRepositories({ state, dataDir, maxMediaBytes });
const auth = {
  async authenticate(header) {
    const match = /^Bearer ([^\s]+)$/.exec(header || '');
    if (!match) return null;
    const supplied = Buffer.from(match[1]);
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    return { ownerId, scopes: ['creator:media:write', 'creator:project:write', 'creator:task:read'] };
  },
};

const server = createServer(createApiHandler({ repositories, auth, maxMediaBytes }));
server.listen(Number(process.env.HAEJUMI_PORT || 8765), host, () => {
  process.stdout.write(`Haejumi reference backend listening on http://${host}:${server.address().port}\n`);
});
