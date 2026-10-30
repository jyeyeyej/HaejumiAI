const API_PREFIX = '/api/v1';
const JSON_LIMIT = 1_048_576;

export function createApiHandler({ repositories, auth, maxMediaBytes }) {
  return async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith(`${API_PREFIX}/`)) return sendError(response, 404, 'RESOURCE_NOT_FOUND');
      const principal = await auth.authenticate(request.headers.authorization);
      if (!principal) return sendError(response, 401, 'AUTHENTICATION_REQUIRED');
      const path = url.pathname.slice(API_PREFIX.length);

      if (request.method === 'POST' && path === '/media/uploads') {
        requireJson(request);
        const body = await readJson(request);
        const result = repositories.createUpload(principal.ownerId, body.items, request.headers['idempotency-key']);
        return sendJson(response, 201, result);
      }

      let match = /^\/media\/uploads\/([0-9a-f-]+)\/parts\/(\d+)$/.exec(path);
      if (request.method === 'PUT' && match) {
        if (request.headers['content-type'] !== 'application/octet-stream') return sendError(response, 415, 'UNSUPPORTED_MEDIA_TYPE');
        requireIdempotencyKey(request);
        const bytes = await readBytes(request, maxMediaBytes);
        repositories.putUploadPart(principal.ownerId, match[1], Number(match[2]), bytes, request.headers['idempotency-key']);
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        return response.end();
      }

      match = /^\/media\/uploads\/([0-9a-f-]+)\/complete$/.exec(path);
      if (request.method === 'POST' && match) {
        requireJson(request);
        requireIdempotencyKey(request);
        const body = await readJson(request);
        return sendJson(response, 200, repositories.completeUpload(principal.ownerId, match[1], body, request.headers['idempotency-key']));
      }

      if (request.method === 'POST' && path === '/content/projects') {
        requireJson(request);
        requireIdempotencyKey(request);
        const body = await readJson(request);
        const result = repositories.createForOwner(principal.ownerId, body, request.headers['idempotency-key']);
        return sendJson(response, 201, result);
      }

      match = /^\/tasks\/([0-9a-f-]+)$/.exec(path);
      if (request.method === 'GET' && match) {
        const task = await repositories.getOwnedTask(principal.ownerId, match[1]);
        if (!task) return sendError(response, 404, 'RESOURCE_NOT_FOUND');
        return sendJson(response, 200, task);
      }
      return sendError(response, 404, 'RESOURCE_NOT_FOUND');
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      const code = error.code || (status === 413 ? 'PAYLOAD_TOO_LARGE' : 'SERVICE_UNAVAILABLE');
      if (status >= 500) process.stderr.write(`request failed: ${code}\n`);
      return sendError(response, status, code);
    }
  };
}

async function readJson(request) {
  const bytes = await readBytes(request, JSON_LIMIT);
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid body');
    return value;
  } catch {
    const error = new Error('Invalid JSON');
    error.status = 422;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
}

function requireJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    const error = new Error('JSON content type required');
    error.status = 415;
    error.code = 'UNSUPPORTED_MEDIA_TYPE';
    throw error;
  }
}

function requireIdempotencyKey(request) {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 16 || key.length > 200) {
    const error = new Error('Idempotency-Key required');
    error.status = 422;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
}

async function readBytes(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Payload too large');
      error.status = 413;
      error.code = 'PAYLOAD_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

const SAFE_MESSAGES = {
  AUTHENTICATION_REQUIRED: '인증이 필요합니다.', FORBIDDEN: '요청 권한이 없습니다.',
  RESOURCE_NOT_FOUND: '리소스를 찾을 수 없습니다.', VALIDATION_ERROR: '요청 형식을 확인해 주세요.',
  PAYLOAD_TOO_LARGE: '허용 크기를 초과했습니다.', UNSUPPORTED_MEDIA_TYPE: '허용되지 않은 미디어 형식입니다.',
  VERSION_CONFLICT: '요청한 파일 또는 버전이 일치하지 않습니다.', INVALID_STATE_TRANSITION: '현재 상태에서 처리할 수 없습니다.',
  IDEMPOTENCY_CONFLICT: '멱등 키가 다른 요청에 사용되었습니다.', CONSENT_REQUIRED: '외부 처리 동의가 없습니다.',
  SERVICE_UNAVAILABLE: '요청을 처리할 수 없습니다.',
};

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

function sendError(response, status, code) {
  const requestId = cryptoRandomId();
  return sendJson(response, status, { error: { code, message: SAFE_MESSAGES[code] || '요청을 처리할 수 없습니다.' }, request_id: requestId });
}

function cryptoRandomId() {
  return globalThis.crypto.randomUUID();
}
