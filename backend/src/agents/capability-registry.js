const ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

const BUILT_INS = [
  { module_id: 'creator', agent_name: 'Creator Agent', module_version: '0.1.0', status: 'enabled', implementation_status: 'implemented', capability_ids: ['creator.shorts_plan', 'creator.caption_draft'], scopes: ['creator:task:read', 'creator:plan:write'], input_schema_version: '1' },
  { module_id: 'schedule', agent_name: 'Schedule Agent', module_version: '0.1.0', status: 'planned', implementation_status: 'registered', capability_ids: ['schedule.manage'], scopes: [], input_schema_version: '1' },
  { module_id: 'wellness', agent_name: 'Wellness Agent', module_version: '0.1.0', status: 'planned', implementation_status: 'registered', capability_ids: ['wellness.record'], scopes: [], input_schema_version: '1' },
  { module_id: 'diary', agent_name: 'Diary Agent', module_version: '0.1.0', status: 'planned', implementation_status: 'registered', capability_ids: ['diary.draft'], scopes: [], input_schema_version: '1' },
  { module_id: 'blog', agent_name: 'Blog module', module_version: '0.1.0', status: 'disabled', implementation_status: 'extension_placeholder', capability_ids: ['blog.draft', 'blog.publish'], scopes: [], input_schema_version: '1' },
  { module_id: 'music', agent_name: 'Music module', module_version: '0.1.0', status: 'disabled', implementation_status: 'extension_placeholder', capability_ids: ['music.compose', 'music.catalog'], scopes: [], input_schema_version: '1' },
];

export class CapabilityRegistry {
  constructor(entries = BUILT_INS) {
    this.entries = new Map();
    for (const entry of entries) this.register(entry);
  }

  register(entry) {
    if (!entry || !ID_PATTERN.test(entry.module_id ?? '') || !Array.isArray(entry.capability_ids) ||
        entry.capability_ids.some((id) => !ID_PATTERN.test(id)) || !['enabled', 'disabled', 'planned'].includes(entry.status)) {
      throw new TypeError('Invalid capability registration.');
    }
    if (this.entries.has(entry.module_id)) throw new Error('Capability module is already registered.');
    const allCapabilities = new Set([...this.entries.values()].flatMap((item) => item.capability_ids));
    if (entry.capability_ids.some((id) => allCapabilities.has(id))) throw new Error('Capability ID is already registered.');
    this.entries.set(entry.module_id, structuredClone(entry));
  }

  get(moduleId) { return this.entries.has(moduleId) ? structuredClone(this.entries.get(moduleId)) : null; }
  list() { return [...this.entries.values()].map((entry) => structuredClone(entry)); }
  resolveCapability(capabilityId) {
    for (const entry of this.entries.values()) if (entry.capability_ids.includes(capabilityId)) return structuredClone(entry);
    return null;
  }
}

export const createDefaultCapabilityRegistry = () => new CapabilityRegistry();
