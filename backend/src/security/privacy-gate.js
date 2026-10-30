/**
 * Fail-closed boundary for any future external processor. No external dispatch
 * implementation is wired into this initial slice.
 */
export class PrivacyGate {
  constructor({ enabled = false, providerAllowlist = [], consentVerifier = async () => false } = {}) {
    this.enabled = enabled === true;
    this.providerAllowlist = new Set(providerAllowlist);
    this.consentVerifier = consentVerifier;
  }

  async authorizeExternalProcessing(context) {
    if (!this.enabled || !this.providerAllowlist.has(context?.providerId)) return { allowed: false, code: 'CONSENT_REQUIRED' };
    try {
      const verified = await this.consentVerifier(context);
      if (verified !== true) return { allowed: false, code: 'CONSENT_REQUIRED' };
      return { allowed: true };
    } catch {
      return { allowed: false, code: 'PRIVACY_POLICY_DENIED' };
    }
  }

  async dispatchExternal(_context, _dispatch) {
    const decision = await this.authorizeExternalProcessing(_context);
    if (!decision.allowed) {
      const error = new Error('External processing is not enabled');
      error.status = 403;
      error.code = decision.code;
      throw error;
    }
    if (typeof _dispatch !== 'function') throw new Error('No external processor is configured');
    return _dispatch();
  }
}
