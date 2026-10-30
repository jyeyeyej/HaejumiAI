export class LLMGateway {
  constructor({ enabled = false, privacyGate, provider = null, limits = {}, state = null, allowMockProvider = false, now = () => new Date() } = {}) {
    this.enabled = enabled === true;
    this.privacyGate = privacyGate;
    this.provider = provider;
    this.allowMockProvider = allowMockProvider === true;
    this.state = state;
    this.now = now;
    this.limits = {
      dailyUsd: positiveNumber(limits.dailyUsd, 0.20),
      monthlyUsd: positiveNumber(limits.monthlyUsd, 5),
      maxCallsPerTask: positiveInteger(limits.maxCallsPerTask, 5),
      maxRevisionsPerTask: positiveInteger(limits.maxRevisionsPerTask, 3),
    };
    this.usage = state?.data?.llmBudget ?? { day: null, month: null, dailyUsd: 0, monthlyUsd: 0, callsByTask: {}, revisionsByTask: {} };
    this.usage.callsByTask ??= {};
    this.usage.revisionsByTask ??= {};
    if (state) state.data.llmBudget = this.usage;
  }

  async generate({ ownerId = null, taskId, revision = false, consentId = null, purpose = 'llm_text', dataCategories = ['user_text'], resourceIds = [], prompt, input }) {
    if (!this.enabled) return { available: false, reason: 'llm_disabled', usage: emptyUsage() };
    if (!this.provider) return { available: false, reason: 'provider_unavailable', usage: emptyUsage() };
    if (typeof prompt !== 'string' || !taskId) return { available: false, reason: 'invalid_context', usage: emptyUsage() };
    this.refreshWindow();
    const calls = this.usage.callsByTask[taskId] ?? 0;
    const revisions = this.usage.revisionsByTask[taskId] ?? 0;
    if (calls >= this.limits.maxCallsPerTask || (revision && revisions >= this.limits.maxRevisionsPerTask)) {
      return { available: false, reason: 'LLM_BUDGET_EXCEEDED', usage: emptyUsage() };
    }
    const estimate = typeof this.provider.estimateCostUsd === 'function' ? await this.provider.estimateCostUsd({ prompt, input }) : null;
    if (!Number.isFinite(estimate) || estimate < 0 || this.usage.dailyUsd + estimate > this.limits.dailyUsd || this.usage.monthlyUsd + estimate > this.limits.monthlyUsd) {
      return { available: false, reason: 'LLM_BUDGET_EXCEEDED', usage: emptyUsage() };
    }
    const reserve = () => {
      // A timeout may have reached the provider; retain the reservation to prevent a
      // blind retry from exceeding the budget. Privacy denial happens before reserve.
      this.usage.dailyUsd += estimate;
      this.usage.monthlyUsd += estimate;
      this.usage.callsByTask[taskId] = calls + 1;
      if (revision) this.usage.revisionsByTask[taskId] = revisions + 1;
      this.state?.save();
    };
    try {
      const response = this.provider.mode === 'mock' && this.allowMockProvider
        ? await (async () => { reserve(); return this.provider.generateStructured({ prompt, input }); })()
        : await this.privacyGate.dispatchExternal({ ownerId, taskId, consentId, resourceIds, purpose, providerId: this.provider.providerId,
          dataCategories, estimatedCostUsd: estimate }, async () => { reserve(); return this.provider.generateStructured({ prompt, input }); });
      if (!response || typeof response !== 'object' || Array.isArray(response)) return { available: false, reason: 'INVALID_MODEL_OUTPUT', usage: emptyUsage() };
      return { available: true, output: response, reason: null, usage: { estimated_cost_usd: estimate, calls_for_task: calls + 1, revisions_for_task: revisions + Number(revision) } };
    } catch (error) {
      return { available: false, reason: safeReason(error), usage: emptyUsage() };
    }
  }

  refreshWindow() {
    const current = this.now();
    const day = current.toISOString().slice(0, 10);
    const month = current.toISOString().slice(0, 7);
    if (this.usage.day !== day) { this.usage.day = day; this.usage.dailyUsd = 0; }
    if (this.usage.month !== month) { this.usage.month = month; this.usage.monthlyUsd = 0; }
    this.state?.save();
  }
}

const emptyUsage = () => ({ estimated_cost_usd: 0, calls_for_task: 0, revisions_for_task: 0 });
const safeReason = (error) => ['CONSENT_REQUIRED', 'PRIVACY_POLICY_DENIED', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'LLM_BUDGET_EXCEEDED'].includes(error?.code) ? error.code : 'SERVICE_UNAVAILABLE';
function positiveNumber(value, fallback) { return Number.isFinite(value) && value >= 0 ? value : fallback; }
function positiveInteger(value, fallback) { return Number.isSafeInteger(value) && value >= 0 ? value : fallback; }
