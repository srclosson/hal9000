// Preview mode (HAL_PREVIEW=1): a copy of the 9000 built from a pull request, for a person to try before it ships.
// It sees what the real one sees, but cannot change anything or speak for it:
//   - only read tools: MCP tools that change things, "ask first" tools and approval steps are off (mcp/index.js)
//   - no plans (fixes/index.js), so no capability requests and nothing approved here
//   - no alert announcements and no automatic Aiden investigations (server.js)
//   - no writes to StackGen Incidents: no incidents, timeline entries, settings or capability records (incidents/,
//     config/); reads (and memory recall) still work
//   - memory reads as usual; memory writes go to a scratch collection (memory/index.js)
// A preview can never promote itself: shipping is decided on the real 9000's monitor (capabilities/index.js).
export const PREVIEW = /^(1|true|yes)$/i.test(process.env.HAL_PREVIEW ?? '');
export const SCRATCH_COLLECTION = process.env.HAL_PREVIEW_COLLECTION || 'hal9000-preview';
export const refused = what => `Error: this is a preview of the 9000; ${what} is switched off here.`;
