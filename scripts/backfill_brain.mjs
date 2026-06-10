// FULL Brain backfill — the all-seeing pass, run on demand (owner directive:
// "go back in time and learn about the company; any tool connected to the brain
// or daemon, ingest everything it sees").
//
// For EVERY workspace, without the serverless cron's 60s budget:
//   1. connector ingest over workspace_integrations ∪ user_integrations
//      (each connector pulls as far back as its API allows)
//   2. scanOneWorkspace      — external/web market intel → hunt findings
//   3. detectPatterns        — cross-staff patterns from full interactions
//   4. nightlyDeepPass       — deep-model mining of recent activity
//   5. buildGraph            — org knowledge graph
//   6. auditBrain            — the brain's self-audit learning pass
//   7. reindexWorkspace      — embeddings for everything new
//
// Idempotent: connectors upsert by external_id; findings dedupe; re-runs refresh.
//   node scripts/backfill_brain.mjs            # all workspaces
//   node scripts/backfill_brain.mjs --ws=Name  # one workspace
// ⚠️ Operates on the prod DB.
import { readFileSync } from 'node:fs';
for (const l of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
process.env.SUPABASE_URL ||= process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;

const { adminClient } = await import('../api/_lib/supabase.js');
const { CONNECTORS } = await import('../api/_lib/connectors/index.js');
const { getAccessToken, getUserTokens } = await import('../api/_lib/oauth.js');
const { scanOneWorkspace, SCAN_COLUMNS } = await import('../api/_lib/research_actions.js');
const { detectPatterns, nightlyDeepPass, buildGraph } = await import('../api/brain.js');
const { auditBrain } = await import('../api/_lib/learning.js');
const { reindexWorkspace } = await import('../api/_lib/ingestion.js');

const db = adminClient();
const only = (process.argv.find(a => a.startsWith('--ws=')) || '').slice(5);

const { data: wss } = await db.from('workspaces').select(SCAN_COLUMNS);
const targets = (wss || []).filter(w => !only || w.name === only);
console.log(`backfilling ${targets.length} workspace(s)…\n`);

const step = async (label, fn) => {
  const t = Date.now();
  try {
    const r = await fn();
    console.log(`  ✓ ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`, r ? JSON.stringify(r).slice(0, 120) : '');
  } catch (e) { console.log(`  ✗ ${label}:`, e.message); }
};

for (const w of targets) {
  console.log(`── ${w.name} (${w.id.slice(0, 8)}…)`);

  // 1. ALL-SEEING connector sweep: workspace connections ∪ per-user connections.
  const { data: integ } = await db.from('workspace_integrations')
    .select('provider').eq('workspace_id', w.id).eq('status', 'connected');
  const { data: userInteg } = await db.from('user_integrations')
    .select('provider').eq('workspace_id', w.id);
  const providers = [...new Set([
    ...(integ || []).map(i => i.provider),
    ...(userInteg || []).map(i => i.provider),
  ])];
  for (const provider of providers) {
    const conn = CONNECTORS[provider];
    if (!conn) { console.log(`  - ${provider}: no connector yet`); continue; }
    await step(`ingest ${provider}`, async () => {
      // Workspace token, else act through a staff token (per-user-only connections).
      const tok = await getAccessToken(db, w.id, provider)
        || (await getUserTokens(db, w.id, provider))[0]?.token
        || null;
      return conn.ingest(db, w.id, tok);
    });
  }
  if (!providers.length) console.log('  - no connected tools');

  // 2-6. Brain passes (each isolated; failure of one never stops the rest).
  await step('scanOneWorkspace', () => scanOneWorkspace(db, w));
  await step('detectPatterns',   () => detectPatterns(w.id, db));
  await step('nightlyDeepPass',  () => nightlyDeepPass(w.id, db));
  await step('buildGraph',       () => buildGraph(w.id, db));
  await step('auditBrain',       () => auditBrain(db, w.id));

  // 7. Embeddings for everything that landed.
  await step('reindexWorkspace', () => reindexWorkspace(db, w.id));
  console.log('');
}
console.log('backfill complete.');
