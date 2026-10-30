const API_PREFIX = '/api/v1';
const JSON_LIMIT = 1_048_576;

export function createApiHandler({ repositories, auth, maxMediaBytes, renderCoordinator = null, capabilityRegistry = null, supervisorRouter = null, creatorAgent = null }) {
  return async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith(`${API_PREFIX}/`)) return sendError(response, 404, 'RESOURCE_NOT_FOUND');
      const principal = await auth.authenticate(request.headers.authorization);
      if (!principal) return sendError(response, 401, 'AUTHENTICATION_REQUIRED');
      const path = url.pathname.slice(API_PREFIX.length);

      if (request.method === 'GET' && path === '/capabilities') {
        if (!capabilityRegistry) return sendError(response, 503, 'SERVICE_UNAVAILABLE');
        return sendJson(response, 200, { items: capabilityRegistry.list() });
      }

      if (request.method === 'POST' && path === '/assistant/messages') {
        if (!supervisorRouter || !creatorAgent) return sendError(response, 503, 'SERVICE_UNAVAILABLE');
        requireJson(request); requireIdempotencyKey(request);
        const body = await readJson(request);
        if (Object.keys(body).some((key) => !['text', 'input_kind', 'confirmed_transcript', 'attachment_ids', 'task_id'].includes(key)) ||
            typeof body.text !== 'string' || !body.text.trim() || body.text.length > 12000 ||
            (body.input_kind !== undefined && !['typed_text', 'confirmed_transcript'].includes(body.input_kind)) ||
            (body.confirmed_transcript !== undefined && typeof body.confirmed_transcript !== 'boolean') ||
            (body.task_id !== undefined && typeof body.task_id !== 'string') ||
            (body.attachment_ids !== undefined && (!Array.isArray(body.attachment_ids) || body.attachment_ids.some((id) => typeof id !== 'string')))) {
          return sendError(response, 422, 'VALIDATION_ERROR');
        }
        if (body.input_kind === 'confirmed_transcript' && body.confirmed_transcript !== true) return sendError(response, 409, 'TRANSCRIPT_CONFIRMATION_REQUIRED');
        if (body.task_id && !(await repositories.getOwnedTask(principal.ownerId, body.task_id))) return sendError(response, 404, 'RESOURCE_NOT_FOUND');
        const responseBody = await repositories.withIdempotentResponse(principal.ownerId, 'assistant', request.headers['idempotency-key'], JSON.stringify(body), async () => {
          const route = supervisorRouter.route(body.text);
          let plan = null;
          let checkpoint = null;
          let generation = null;
          let contentVersion = null;
          let contentHash = null;
          let taskId = body.task_id ?? null;
          let reply = routeReply(route);
          if (route.status === 'routed' && route.module_id === 'creator') {
            if (!taskId) {
              reply = 'Creator 프로젝트를 선택한 뒤 기획 요청을 다시 보내 주세요. 업로드한 전체 갤러리는 검색하지 않습니다.';
            } else {
              const context = repositories.getOwnedCreatorContext(principal.ownerId, taskId, body.attachment_ids ?? []);
              if (!context) throw Object.assign(new Error('Creator task not found'), { status: 404, code: 'RESOURCE_NOT_FOUND' });
              const result = await repositories.createCreatorPlan(principal.ownerId, taskId,
                { content_version: context.task.current_version, request_text: body.text }, request.headers['idempotency-key'], creatorAgent);
              plan = result.plan; checkpoint = result.checkpoint; taskId = result.task_id;
              generation = result.generation;
              contentVersion = result.content_version; contentHash = result.content_hash;
              reply = result.generation.fallback_used
                ? '선택하신 프로젝트의 쇼츠 기획안을 만들었습니다. 기획을 승인하시면 자막 초안을 확인하실 수 있습니다.'
                : '쇼츠 기획안을 만들었습니다. 기획을 승인하시면 자막 초안을 확인하실 수 있습니다.';
            }
          }
          const response = { reply, route: route.module_id ?? 'unresolved', agent_id: route.module_id, capability_id: route.capability_id,
            status: route.status === 'routed' && route.module_id === 'creator' && !taskId ? 'needs_project' : route.status };
          if (taskId) response.task_id = taskId;
          if (plan) { response.plan = plan; response.checkpoint = checkpoint; response.generation = generation; response.content_version = contentVersion; response.content_hash = contentHash; }
          return response;
        });
        return sendJson(response, 202, responseBody);
      }

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

      match = /^\/tasks\/([0-9a-f-]+)\/plan$/.exec(path);
      if (request.method === 'GET' && match) {
        try {
          const plan = repositories.getOwnedCreatorPlan(principal.ownerId, match[1]);
          if (!plan) return sendError(response, 404, 'RESOURCE_NOT_FOUND');
          return sendJson(response, 200, plan);
        } catch (error) { throw error; }
      }
      if (request.method === 'POST' && match) {
        if (!creatorAgent) return sendError(response, 503, 'SERVICE_UNAVAILABLE');
        requireJson(request); requireIdempotencyKey(request);
        const body = await readJson(request);
        return sendJson(response, 201, await repositories.createCreatorPlan(principal.ownerId, match[1], body, request.headers['idempotency-key'], creatorAgent));
      }

      match = /^\/tasks\/([0-9a-f-]+)\/draft$/.exec(path);
      if (request.method === 'GET' && match) {
        const draft = repositories.getOwnedCaptionDraft(principal.ownerId, match[1]);
        if (!draft) return sendError(response, 404, 'RESOURCE_NOT_FOUND');
        return sendJson(response, 200, draft);
      }

      match = /^\/tasks\/([0-9a-f-]+)\/checkpoints$/.exec(path);
      if (request.method === 'GET' && match) {
        const checkpoints = repositories.getOwnedCheckpoints(principal.ownerId, match[1]);
        if (!checkpoints) return sendError(response, 404, 'RESOURCE_NOT_FOUND');
        return sendJson(response, 200, { items: checkpoints });
      }

      match = /^\/tasks\/([0-9a-f-]+)\/approvals$/.exec(path);
      if (request.method === 'POST' && match) {
        requireJson(request); requireIdempotencyKey(request);
        const body = await readJson(request);
        return sendJson(response, 201, repositories.approveCheckpoint(principal.ownerId, match[1], body, request.headers['idempotency-key']));
      }

      match = /^\/tasks\/([0-9a-f-]+)\/publications$/.exec(path);
      if (match && request.method === 'POST') {
        requireJson(request); requireIdempotencyKey(request);
        return sendJson(response, 201, repositories.createPublication(principal.ownerId, match[1], await readJson(request), request.headers['idempotency-key']));
      }
      if (match && request.method === 'GET') {
        const items = repositories.listPublications(principal.ownerId, match[1]);
        if (!items) return sendError(response, 404, 'RESOURCE_NOT_FOUND');
        return sendJson(response, 200, { items });
      }
      match = /^\/tasks\/([0-9a-f-]+)\/publications\/([0-9a-f-]+)$/.exec(path);
      if (match && request.method === 'GET') {
        const item = repositories.getPublication(principal.ownerId, match[1], match[2]);
        if (!item) return sendError(response, 404, 'RESOURCE_NOT_FOUND');
        return sendJson(response, 200, item);
      }
      if (match && request.method === 'PATCH') {
        requireJson(request); requireIdempotencyKey(request);
        return sendJson(response, 200, repositories.updatePublication(principal.ownerId, match[1], match[2], await readJson(request), request.headers['idempotency-key']));
      }
      match = /^\/tasks\/([0-9a-f-]+)\/publications\/([0-9a-f-]+)\/approvals$/.exec(path);
      if (match && request.method === 'POST') {
        requireJson(request); requireIdempotencyKey(request);
        return sendJson(response, 201, repositories.approvePublication(principal.ownerId, match[1], match[2], await readJson(request), request.headers['idempotency-key']));
      }

      match = /^\/tasks\/([0-9a-f-]+)\/render$/.exec(path);
      if (request.method === 'POST' && match) {
        if (!renderCoordinator) return sendError(response, 503, 'SERVICE_UNAVAILABLE');
        requireJson(request); requireIdempotencyKey(request);
        const body = await readJson(request);
        const result = repositories.createRenderJob(principal.ownerId, match[1], body, request.headers['idempotency-key']);
        if (result.created) renderCoordinator.enqueue(result.job.job_id);
        return sendJson(response, 202, result.job);
      }

      match = /^\/jobs\/([0-9a-f-]+)$/.exec(path);
      if (request.method === 'GET' && match) {
        const job = repositories.getOwnedJob(principal.ownerId, match[1]);
        if (!job) return sendError(response, 404, 'RESOURCE_NOT_FOUND');
        return sendJson(response, 200, job);
      }

      match = /^\/jobs\/([0-9a-f-]+)\/cancel$/.exec(path);
      if (request.method === 'POST' && match) {
        if (!renderCoordinator) return sendError(response, 503, 'SERVICE_UNAVAILABLE');
        requireIdempotencyKey(request);
        return sendJson(response, 200, await renderCoordinator.cancel(principal.ownerId, match[1]));
      }

      match = /^\/tasks\/([0-9a-f-]+)\/preview$/.exec(path);
      if (request.method === 'GET' && match) {
        const version = Number(url.searchParams.get('content_version'));
        if (!Number.isSafeInteger(version) || version < 1) return sendError(response, 422, 'VALIDATION_ERROR');
        const preview = repositories.getOwnedPreview(principal.ownerId, match[1], version);
        if (!preview) return sendError(response, 404, 'RESOURCE_NOT_FOUND');
        if (preview.mode === 'ffmpeg' && !preview.artifact_verified) return sendError(response, 409, 'RENDER_VALIDATION_FAILED');
        response.writeHead(200, { 'Content-Type': preview.mode === 'test' ? 'application/x-haejumi-test-preview' : 'video/mp4',
          'Content-Length': preview.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Haejumi-Render-Mode': preview.mode });
        return response.end(preview.bytes);
      }

      match = /^\/content\/projects\/([0-9a-f-]+)$/.exec(path);
      if (request.method === 'GET' && match) {
        const project = repositories.getOwnedProject(principal.ownerId, match[1]);
        if (!project) return sendError(response, 404, 'RESOURCE_NOT_FOUND');
        return sendJson(response, 200, project);
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
  APPROVAL_SCOPE_MISMATCH: '이 체크포인트에 허용되지 않는 승인입니다.', RENDER_FAILED: '렌더 작업에 실패했습니다.',
  RENDER_VALIDATION_FAILED: '렌더 결과 검증에 실패했습니다.', FFPROBE_UNAVAILABLE: 'ffprobe 검증 도구를 사용할 수 없습니다.',
  IDEMPOTENCY_CONFLICT: '멱등 키가 다른 요청에 사용되었습니다.', CONSENT_REQUIRED: '외부 처리 동의가 없습니다.',
  PUBLICATION_ALREADY_EXISTS: '해당 플랫폼 게시 정보가 이미 있습니다.', RENDER_REQUIRED: '실제 FFmpeg 및 ffprobe 검증이 완료된 영상이 필요합니다.',
  SERVICE_UNAVAILABLE: '요청을 처리할 수 없습니다.', TRANSCRIPT_CONFIRMATION_REQUIRED: '음성 인식문을 확인하고 수정한 뒤 다시 요청해 주세요.',
  LLM_BUDGET_EXCEEDED: 'LLM 사용 한도에 도달했습니다. 로컬 처리로 전환합니다.',
};

function routeReply(route) {
  if (route.status === 'needs_clarification') return route.reason === 'ambiguous_request' ? '어떤 Agent 작업을 원하시는지 한 가지로 지정해 주세요.' : '요청 내용을 조금 더 구체적으로 말씀해 주세요.';
  if (route.status === 'disabled') return '요청하신 기능은 아직 비활성 상태입니다.';
  if (route.status === 'not_implemented') return '해당 Agent는 등록되어 있지만 아직 구현되지 않았습니다.';
  if (route.status === 'unsupported') return '현재 등록된 기능에서 요청을 처리할 수 없습니다.';
  return '요청을 담당 Agent로 전달했습니다.';
}

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
