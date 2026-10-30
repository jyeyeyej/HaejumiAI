/**
 * Fail-closed boundary for any future external processor. No external dispatch
 * implementation is wired into this initial slice.
 */
export class PrivacyGate {
  async authorizeExternalProcessing(_context) {
    return { allowed: false, code: 'CONSENT_REQUIRED' };
  }

  async dispatchExternal(_context, _dispatch) {
    const decision = await this.authorizeExternalProcessing(_context);
    if (!decision.allowed) {
      const error = new Error('External processing is not enabled');
      error.status = 403;
      error.code = decision.code;
      throw error;
    }
    // Intentionally unreachable in this scaffold: an external dispatcher must
    // only be injected after the consent policy and provider allowlist are approved.
    throw new Error('No external processor is configured');
  }
}
