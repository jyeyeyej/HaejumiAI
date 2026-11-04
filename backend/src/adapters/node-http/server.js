import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonState } from '../filesystem/json-state.js';
import { WebSessions } from '../filesystem/web-sessions.js';
import { LocalRepositories } from '../filesystem/repositories.js';
import { createApiHandler } from './transport.js';
import { loadDotEnv } from '../../config/dotenv.js';
import { ensureStorageDirectory, safeStoragePath } from '../../security/storage-paths.js';
import { createRenderCoordinator } from '../../application/render-coordinator.js';
import { createFFmpegRenderer } from '../../media-engine/ffmpeg-renderer.js';
import { resolveMediaToolPaths } from '../../media-engine/media-tool-paths.js';
import { createDefaultCapabilityRegistry } from '../../agents/capability-registry.js';
import { SupervisorRouter } from '../../agents/supervisor-router.js';
import { CreatorAgent } from '../../agents/creator-agent.js';
import { LLMGateway } from '../../application/llm-gateway.js';
import { PrivacyGate } from '../../security/privacy-gate.js';
import { OpenAIProvider } from '../../application/openai-provider.js';
import { createFFmpegFrameExtractor } from '../../media-engine/ffmpeg-frame-extractor.js';
import { createFFmpegImagePreparer } from '../../media-engine/ffmpeg-image-preparer.js';
import { YouTubeTrends } from '../../application/youtube-trends.js';

const projectRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
loadDotEnv(join(projectRoot, '.env'));

const host = process.env.HAEJUMI_BIND_HOST || '127.0.0.1';
if (host !== '127.0.0.1') throw new Error('The reference server must bind to 127.0.0.1 only.');
const token = process.env.HAEJUMI_BEARER_TOKEN;
const ownerId = process.env.HAEJUMI_OWNER_ID;
if (!token || token.length < 32 || token.includes('replace-with-')) {
  throw new Error('Set HAEJUMI_BEARER_TOKEN to a locally generated secret of at least 32 characters.');
}
if (!ownerId) throw new Error('Set HAEJUMI_OWNER_ID before starting the server.');

const dataDir = ensureStorageDirectory(resolve(process.env.HAEJUMI_DATA_DIR || './data'));
const maxMediaBytes = Number(process.env.HAEJUMI_MAX_MEDIA_BYTES || 52_428_800);
if (!Number.isSafeInteger(maxMediaBytes) || maxMediaBytes < 1) throw new Error('Invalid HAEJUMI_MAX_MEDIA_BYTES.');
const maxSelectedMedia = parseInteger(process.env.HAEJUMI_MAX_SELECTED_MEDIA, 20);
if (maxSelectedMedia < 1 || maxSelectedMedia > 30) throw new Error('Invalid HAEJUMI_MAX_SELECTED_MEDIA.');
const maxVisionImages = parseInteger(process.env.HAEJUMI_OPENAI_MAX_IMAGES_PER_ANALYSIS, 5);
if (maxVisionImages < 1 || maxVisionImages > 20) throw new Error('Invalid HAEJUMI_OPENAI_MAX_IMAGES_PER_ANALYSIS.');
// Loading a key never grants permission to make a paid request. The additional
// switch is intentionally absent from existing installations and defaults off.
const llmEnabled = parseBoolean(process.env.HAEJUMI_LLM_ENABLED, false) && parseBoolean(process.env.HAEJUMI_OPENAI_LIVE_ENABLED, false);
const openAiKey = process.env.HAEJUMI_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
const openAiModel = process.env.HAEJUMI_OPENAI_MODEL || process.env.OPENAI_MODEL || '';
const openAiProvider = llmEnabled && openAiKey && openAiModel ? new OpenAIProvider({ apiKey: openAiKey, model: openAiModel,
  timeoutMs: parseInteger(process.env.HAEJUMI_OPENAI_TIMEOUT_MS, 20_000),
  maxImages: maxVisionImages,
  estimatedCostUsd: parseNumber(process.env.HAEJUMI_LLM_ESTIMATED_COST_PER_ITEM_USD, 0.01) }) : null;

const state = new JsonState(safeStoragePath(dataDir, 'state.json'));
const mediaToolPaths = resolveMediaToolPaths();
const webSessions = new WebSessions(safeStoragePath(dataDir, 'web-sessions.json'), token, ownerId,
  { secureCookie: process.env.HAEJUMI_WEB_COOKIE_SECURE === 'true' });
const repositories = new LocalRepositories({ state, dataDir, maxMediaBytes, maxSelectedMedia, maxVisionImages,
  videoFrameExtractor: openAiProvider ? createFFmpegFrameExtractor({ ffmpegPath: mediaToolPaths.ffmpegPath }) : null,
  imagePreparer: openAiProvider ? createFFmpegImagePreparer({ ffmpegPath: mediaToolPaths.ffmpegPath }) : null });
const privacyGate = new PrivacyGate({ enabled: Boolean(llmEnabled && openAiProvider), providerAllowlist: openAiProvider ? ['openai'] : [],
  consentVerifier: (context) => repositories.verifyPrivacyConsent(context) });
const llmGateway = new LLMGateway({ enabled: llmEnabled, provider: openAiProvider, privacyGate, state,
  limits: { dailyUsd: parseNumber(process.env.HAEJUMI_LLM_DAILY_BUDGET_USD, 0.20),
    monthlyUsd: parseNumber(process.env.HAEJUMI_LLM_MONTHLY_BUDGET_USD, 5),
    maxCallsPerTask: parseInteger(process.env.HAEJUMI_LLM_MAX_CALLS_PER_TASK, 5),
    maxRevisionsPerTask: parseInteger(process.env.HAEJUMI_LLM_MAX_REVISIONS_PER_TASK, 3) } });
const capabilityRegistry = createDefaultCapabilityRegistry();
const supervisorRouter = new SupervisorRouter(capabilityRegistry);
const creatorAgent = new CreatorAgent({ gateway: llmGateway });
const trends = new YouTubeTrends({ apiKey: process.env.HAEJUMI_YOUTUBE_API_KEY ?? '',
  enabled: parseBoolean(process.env.HAEJUMI_TRENDS_LIVE_ENABLED, false) });
const renderDir = ensureStorageDirectory(safeStoragePath(dataDir, 'renders'), dataDir);
const renderer = createFFmpegRenderer({ mediaRoot: repositories.blobDir, outputRoot: renderDir, ...mediaToolPaths });
const renderCoordinator = createRenderCoordinator({ repositories, renderer });
renderCoordinator.resumeQueued();
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

const server = createServer(createApiHandler({ repositories, auth, webSessions, maxMediaBytes, renderCoordinator, capabilityRegistry, supervisorRouter, creatorAgent, llmGateway, trends }));
server.listen(Number(process.env.HAEJUMI_PORT || 8765), host, () => {
  process.stdout.write(`Haejumi reference backend listening on http://${host}:${server.address().port}\n`);
});

function parseBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Invalid HAEJUMI_LLM_ENABLED; use true or false.');
}
function parseNumber(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('Invalid LLM budget setting.');
  return number;
}
function parseInteger(value, fallback) {
  const number = parseNumber(value, fallback);
  if (!Number.isSafeInteger(number)) throw new Error('Invalid LLM limit setting.');
  return number;
}
