# Connector contract — how every tool integration must ingest

The master to-build list is the 9,637-app catalog (`docs/integrations/CATALOG.md`);
priority order + OAuth setup lives in `INTEGRATIONS.md`. This file is the
**quality bar**: every connector — present and future — meets ALL of it before
it ships. The Brain is an all-seeing entity (memory: `decision-brain-all-seeing`):
it ingests everything a connected tool can see; visibility scoping controls who
*reads* it, never whether it's ingested.

## The contract

Each connector is a module in this directory, registered in `index.js`, exporting:

```js
export async function ingest(db, workspaceId, workspaceToken /* string|null */)
```

**1. All-seeing token handling.** `workspaceToken` may be `null` (tool connected
only by individual staff). The connector MUST still ingest:
- Best (Slack is the reference): sweep **every** staff token via
  `getUserTokens(db, workspaceId, provider)` AND the workspace token, merging
  results — each private item access-scoped to the users whose tokens saw it.
- Minimum: callers (cron `scan_external`, `scripts/backfill_brain.mjs`) pass a
  staff token as fallback when the workspace token is null — never throw on a
  "wrong-shaped" token; degrade to what it can read.

**2. Idempotent upserts via `upsertDocuments(db, workspaceId, source, docs)`.**
- `external_id` = the tool's own stable id (channel id, page id, issue key…) —
  NEVER timestamps or array indices, so re-ingests refresh instead of duplicate.
- `title` human-readable with the tool named (e.g. `#general (Slack)`),
  `content` the real text (cap ~8K — upsertDocuments enforces; embedding uses
  the first 6K), `url` deep link when the tool has one, `doc_type` specific
  (`message_channel`, `page`, `issue`, `deal`, `email`, `conversation`…).

**3. Access scoping, not censoring.** Private content IS ingested, with
`visibility: 'restricted'` + `allowed_users: [user ids that may read it]`.
Public/company-wide content gets `visibility: 'public'`. `retrieveDocuments`
then gives non-members a pointer ("exists, ask X") — never the content — and
the gateway MCP search tool never returns restricted rows at all.
Personal 1:1 DMs are the ONE exclusion (they don't belong in a company brain).

**4. Bounded and polite.** Every fetch timeout-capped (`AbortSignal.timeout`);
honor 429/`Retry-After` with bounded retries (see `slackApi()`); page caps so
one giant workspace can't blow the cron budget — go deep on the next sweep
(the cron is round-robin; ingestion compounds across runs).

**5. History-greedy.** Pull as far back as the API reasonably allows on first
ingest (messages + threads + pins + files, not just "recent") — backfill IS the
feature. Subsequent runs naturally refresh via the idempotent upserts.

**6. Fail soft, log loud.** Throwing is fine (callers isolate per-connector),
but a partial pull should still upsert what it got. `console.error` with the
provider + workspace for anything skipped.

## Shipping checklist for a new connector

1. Module here + entry in `index.js` `CONNECTORS`.
2. OAuth: provider entry in `oauth.js` `PROVIDERS` (+ `<PROVIDER>_CLIENT_ID/SECRET`
   in `.env.example` and Vercel).
3. Meets every contract point above (1-6).
4. Tick the app in `docs/integrations/CATALOG.md` (`- [x]`).
5. Verify: connect → `node scripts/backfill_brain.mjs --ws=<Name>` → documents
   appear embedded + correctly scoped → daemon retrieval cites them.
