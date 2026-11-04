/** A configured key is not permission to make a paid request. */
export function resolveLlmAvailability({ llmRequested, liveEnabled, keyConfigured, modelConfigured }) {
  if (!llmRequested) return { enabled: false, reason: 'LLM_SWITCH_OFF' };
  if (!liveEnabled) return { enabled: false, reason: 'LIVE_SWITCH_OFF' };
  if (!keyConfigured || !modelConfigured) return { enabled: false, reason: 'PROVIDER_CONFIG_MISSING' };
  return { enabled: true, reason: 'READY' };
}
