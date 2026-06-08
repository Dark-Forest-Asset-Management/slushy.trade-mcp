/**
 * Quick smoke test for the bracket-tracker integration. Hits the daemon
 * via the configured URL + calls the same fetchBracketSnapshot helper the
 * MCP tools use, then prints a summary. Run from the slushy-trade-mcp
 * root: `npx tsx scripts/bracket-smoke.ts`
 */
import { config } from '../src/config.js';
import { fetchBracketSnapshot } from '../src/bracket-tracker.js';

const coin = process.argv[2] ?? 'XRP';
console.log(`bracket-tracker url: ${config.bracketTrackerUrl}`);
const d = await fetchBracketSnapshot(coin);
const oco = d.legs.filter((L) => L.bracket === 'oco').length;
const withEntry = d.legs.filter((L) => L.entry_px != null).length;
console.log(`${coin}: block=${d.snapshot_block} age_ms=${d.snapshot_age_ms} legs=${d.legs.length} mid=$${d.mid_usd}`);
console.log(`  oco_legs=${oco} (${oco / 2} pairs)  with_entry=${withEntry}`);
console.log('  sample leg:', JSON.stringify(d.legs[0], null, 2));
