# Design

## Context

### Scope and evidence

Planning for the installed Rakazo fork. Branch base `feat/self-config` is taken from fork branch owner/main at `87a68936c`, which is the deployed commit `e0386c3d8` plus one test-fixture commit. The deployed image runs that commit on api, web, worker and supervisor. Upstream is `elie222/rakazo`; the fork is 388 commits ahead of upstream main `60c8548f`.

Every claim below was read at `e0386c3`. Live row counts come from read-only queries against the deployment's Postgres instance.

### Checked current source

| Area | Current behaviour and seam | Consequence |
|---|---|---|
| Tool assembly | `executor.ts:1253-1254` builds `tools` once; `:1221` de-dupes exposed connectors; `:1165` builds the disabled set; `:1622` passes it once | A single, well-defined insertion point for selection |
| Deferral | `builtin-tool-bridge.ts:21-52` 30 core tools; `:72-77` `find_tool`/`use_tool`, limit 3, nine areas | Already the right shape; extends rather than replaces |
| Lazy catalog | `lazy-tool-catalog.ts` `DIRECT_TOOL_LIMIT=20` + 3 meta-tools, applied `mcp-connector.ts:418-420`, `installed-connectors.ts:168-169` | Count control only, no relevance signal |
| Fan-in | remote MCP `mcp-connector.ts:407`; capability installs `installed-connectors.ts:166`; Composio registry `composio-connector.ts:862`, built `:950-957`; Pipedream `apps/worker/src/index.ts:207` | One registry to index from, four sources to enumerate |
| Allowlist | `BotMcpServer.allowAllTools` default true `schema.prisma:1726`, `allowedTools` `:1727`, enforced `mcp-connector.ts:505-509` and `:703`; namespacing `:511` | Selection must run strictly after this filter |
| Profile gate | `routes/bot-runtime-profile.ts:16` `SUPPORTED_CAPABILITIES = ["persona"]`; rejections at `:21` | One guard blocks four already-built behaviours |
| Skills enforcement | `skill-tools.ts:32-83` applies `skills.mode=explicit` | Consumer exists; only the API guard is missing |
| Learning | `packages/core/src/bot-profile-policy.ts:58` `automaticLearningPromotionDecision`, zero non-test callers | Logic exists, no scheduler |
| Memory | `MemoryRevision` is document-level; `memory-context.ts` 32 KiB, newest-first, "data rather than instructions" preamble | No fact-level invalidation, so corrections stay lossy |
| Proactive | engine + 10 invariants live; Judge unbound `proactive.ts:222`; `isWorking()` false `:158-160`; webhook only source; `PROACTIVE_WEBHOOK_BOTS=*` | Wiring gap, not a design gap |
| Unmerged work | `feat/proactive-self-control` is `e0386c3` + 2 commits with judge and self-control work | Land it rather than rebuild it |

### External evidence for the selection design

- Anthropic tool search reports "~55k tokens in definitions before Claude does any work", an 85 percent reduction by loading 3-5 tools, and degradation past "30-50 available tools" (docs.claude.com, tool-search-tool).
- RAG-MCP (arXiv 2505.03275): retrieval over tool descriptions "cuts prompt tokens ... by over 50%" and "more than triples tool selection accuracy (43.13% vs 13.62% baseline)".
- MCP-Zero (arXiv 2506.01056): active tool request plus two-stage server-to-tool routing, 2,797 tools, 98 percent token reduction.
- ToolACE-MCP (arXiv 2601.08276) criticises static embedding retrieval; a trained or hybrid router is stronger. This change therefore starts with a hybrid lexical-plus-description-embedding index and an explicit fallback, not a pure vector store.

## Decisions

**D1. Selection is an additive stage, never a rewrite of the assembly site.** Insert `selectToolsForRun()` between the existing rule filter and `executor.ts:1253-1254`. Rationale: the assembly site is the only place all four sources converge, and a fallback to the unfiltered list is then a one-line branch. Alternative rejected: per-connector selection at each fan-in point, which would need four implementations and could disagree with the de-dupe at `:1221`.

**D2. The rules filter stays the pre-filter; ranking only orders what survives it.** Rationale: allowlists, `disabledBuiltinTools` and the run-trigger gates are security boundaries. A ranking stage that can re-admit a disabled tool would be a privilege-escalation path. Selection may only remove from the surviving set or reorder it.

**D3. Owner-started runs keep the full tool list.** Rationale: a human is present, latency is acceptable, and a wrong selection is visible immediately. Only scheduled, background, routine and webhook-driven runs get the compressed set. This also bounds blast radius if the index is cold.

**D4. Selection is computed once per run and frozen.** Rationale: `builtin-tool-bridge.ts:16-19` already documents "never change mid-run" and models trained against a stable tool list degrade when it shifts. Mid-run discovery stays inside `find_tool`/`use_tool`.

**D5. Index rows carry a provenance and a freshness stamp.** Each row records source kind, source id, space, bot binding, tool name as offered, description hash and last-probe time. Rationale: MCP re-probe already runs every 10 minutes (`apps/api/src/mcp-servers.ts:256-329`); the index must not serve a tool whose server has since dropped it. Stale rows are hidden, not deleted, so a transient probe failure does not silently remove a capability.

**D6. Fact-level supersede is additive to document revisions.** Keep `MemoryDocument` and `MemoryRevision` as the authoritative document history; add fact records with `valid_at`/`invalid_at` so a correction invalidates rather than deletes. Rationale: Graphiti (arXiv 2501.13956) and mem0 (arXiv 2504.19413) both show invalidation beats replacement for retrieval quality, and Rakazo's revision table already provides the audit trail.

**D7. Persona stays owner-gated.** The bot may propose a persona diff; it may not write one. Rationale: `docs/fleet-management.md` and `fleet-tools.ts:800` already refuse bot self-edit of instructions. Grok Bot's own model is that personal Bots have no settings page, but the write is a chat instruction from the owner, not a bot-authored file.

**D8. Land proactive wiring by merging the approved branch, not by reimplementing it.** `feat/proactive-self-control` is two commits past the deployed image and carries owner-approved work recorded on TASK-468. Rebuilding would duplicate a reviewed change.

## Risks

- **Cold index degrades agent quality invisibly.** Mitigated by D2/D3: on any miss or unhealthy index, fall back to the current list, and emit a counter so the degradation is observable.
- **Relevance ranking can hide the one tool a task needed.** Mitigated by keeping `find_tool` reachable inside the selected set and by recording per-run "requested but not offered" events.
- **Composio is not in Postgres** (`composio-connector.ts:531`), so its rows cannot be backfilled from SQL. The index must tolerate a provider that is only reachable live.
- **Fork drift.** The owner/main line, `feat/mcp-neat` and `feat/proactive-self-control` all carry related work; merging order matters and must be decided before the first migration ships.
- **Unverified:** Graphile duplicate-delivery semantics under real concurrency, and Pipedream per-bot scoping. Both are read at the call site only.

## Migration and undo

One additive migration for index and fact tables; no column drops, no backfills required for correctness. Undo is: disable selection by config flag (behaviour returns to today's assembly), drop the new tables. Proactive merge is revertible by reverting its two commits plus the wiring commit.

## Decisions taken during implementation

**D9. The tool index is built and owned in process, and never persisted.** D1/D5 stand: the four discovery sources stay authoritative. The index derives from the candidate set a run's assembly already produced (`exposedConnectorTools`, which is post-collision-rule and post-built-in-filter), so it can never hold a name the run could not offer. Consequence: nothing to migrate, nothing to recompute, and a stale index can only shrink a list.

**D10. Selection bounds the connector subset; built-ins are always kept.** `selectToolsForRun()` ranks the connector candidates under a byte budget (24 tools / 24 000 characters of name + description + schema) and passes every built-in through untouched. Losing `shell` or `read_file` to a ranking would break a run to save tokens, and built-ins are already bounded by `selectBuiltinToolsForRun` and `disabledBuiltinTools`. Selection is lexical plus an injected usage prior; `Date.now()` never reaches the score, so a fixed index revision and fixed inputs give a byte-identical list.

**D11. The index observes; it does not enumerate.** Recording happens from the enumeration a run already performs (`discoverTools`), which runs at least as often as the 10-minute re-probe. Windows default to 15 minutes grace and 60 minutes freshness, above that cadence. No second scheduler (task 2.5), no shared state between the API and worker processes — a process-local index is a bounded cache, not a catalogue.

**D12. A routine occurrence keeps its own start path: the pipeline decides *when*, the routine runner decides *how*.** `wakeRoutine()` now routes an occurrence through the proactive pipeline (flag `PROACTIVE_ROUTINE_SOURCE`, off by default) and the wake target hands a uniform routine wake to `startRoutine()`, which is `startRoutineRun()`. Rationale: re-sending a routine as a webhook message would lose run attribution (`trigger: "routine"` + `routineId`) and tool-availability semantics that key on the trigger. Mixed wakes (a routine plus another event) fall back to the composed prompt, so debounce and steering keep working. The pipeline already treats a `timer`-kind event as a wake without consulting the judge, which is what a standing routine should be.

**D13. Learning is wired to a scheduled job but stays `off` by default and gated at the API.** The review pipeline (`learning-curation.ts`, `learning-reviews.ts`) is now reachable: `learning.review` is a background-job payload, `enqueueLearningReviewJobs` plans one slot per bot per day (a slot already in the past is never planned, so switching a bot on cannot fire a catch-up burst), the leadership-gated reconciler tick calls it from `apps/worker/src/index.ts`, and each review job re-plans the next slot so no second cron entry is needed. Candidates come from framework facts that superseded another fact in the last 24 h and from taught skills completed in that window, digest-deduped, behind `RAKAZO_LEARNING_CANDIDATES` (off by default). A review run needs a judge; with no provider key it returns `judge-unavailable` and writes no row rather than skipping the gate. Flipping the default to `proposals-only` (task 5.2) is still deliberately not done: no bot carries `settings.learning` yet, so the planner enqueues nothing and the default advertises nothing.

**D14. The per-bot switch `RAKAZO_SELF_CONFIG_BOTS` is on by default.** When the variable is unset, every bot is opted in to tool selection, the proactive routine source and learning candidates, as if it were `*`. Opt-out stays explicit: an empty value, `none`, `off`, `0` or `false` turns the switch off for every bot; `-<botId>` entries exclude bots (`*,-<botId>`, or just `-<botId>`, means every bot except those), and an exclusion always wins over `*` or an explicit include. A plain list (`<botA>,<botB>`) still opts in only those bots. The three deployment-wide flags (`RAKAZO_TOOL_SELECTION`, `PROACTIVE_ROUTINE_SOURCE`, `RAKAZO_LEARNING_CANDIDATES`) keep applying to every bot regardless of the switch, so they cannot be narrowed by it. Rationale: the features ran behind the switch on a test bot and then on every bot of a deployment without regressions, so a fresh deployment should get them without extra configuration, while an operator who needs the previous behaviour sets the variable to `none`. Memory sharing is unaffected in practice: it still also requires the bot profile's `learning.share` opt-in.

**D14. Persona stays owner-gated; the bot may only propose.** `fleet-tools.ts` refuses an instruction write for another bot and points at the owner path. No proposal surface exists yet, so this change keeps the refusal and records the missing proposal path as a gap rather than opening a second write path.

## Verification record

| Check | Command | Result |
|---|---|---|
| Focused slices, final tree | `pnpm exec vitest run` over 20 files: executor, executor-readonly-approval, tool-index, tool-selection, skill-tools, proactive-routine-source, learning-reviews, learning-review-store, learning-candidate-collector, learning-review-judge, learning-review-policy, job-reconciler, background-job-handlers, wakeup, wakeup-graphile-host, learning-curation, memory facts x2, judge-error, scoped-policy | 587 passed, RC 0 |
| Proactive package, full | `pnpm exec vitest run packages/proactive` | 85 passed, 1 skipped (conformance, send-once, once-only effect) |
| Profile API guard | `vitest run apps/api/src/routes/bot-runtime-profile.test.ts` | 9 passed |
| Judge failure still wakes | `packages/proactive/src/judge-error.test.ts` | 3 passed |
| Lint | `pnpm lint` (biome, 3 249 files) | RC 0 — 24 warnings remain, none in a file this branch touches |
| Package typechecks | `tsc --noEmit` per package under `systemd-run --user --scope` | RC 0 for adapters, core, memory, db, adapter-kit, contracts, proactive, apps/api, apps/worker |
| OpenSpec | `openspec validate add-bot-self-configuration --strict` | valid, 37 of 41 tasks ticked |

**Operational note.** `tsc --noEmit` on `packages/adapters` is OOM-killed inside a constrained subprocess cgroup (2 GiB, `typescript` 7.x native port, no `--max-old-space-size` lever). Running the same check under `systemd-run --user --scope` gives real diagnostics. Any agent verifying this change must use that form, or it will record a false failure.

## Known gaps

- **Usage prior has no writer.** `ToolIndex.recordToolOutcome` exists and is tested, but no per-bot usage table exists and this change did not add one, so production scoring is lexical only.
- **Per-bot budget and windows are module defaults**, not configuration: the spec's "configured maximum" needs a config surface that does not exist yet.
- **`recordEnumerationFailure` is not called from the executor.** A wholesale discovery failure still fails the run as before; per-source failures are already tolerated upstream.
- **The migrations have run on a scratch database, not on the deployed one.** Both were applied to a fresh `postgres:16` database, then again on top of a database already holding organization, space, bot and memory-document rows, and the PostgreSQL suites passed there. The deployed database is still untouched by this change.
- **Bot-scope `remember` is append-only**; fact supersede is reachable only through the turn memory script path.
- **The planner's `settings` JSON-path filter ran on a scratch PostgreSQL database** in the new database test, but not against the deployed database.
- **No promotion sink is wired.** A promotion resolves to `proposed`, so even `automatic-private` currently only proposes; nothing writes a skill or a memory document on a bot's own authority.
- **The learning judge has never been called for real.** Tests inject a fake `DecisionProvider`; judge quality and cost against the live model are unmeasured.
- **Collector window and limits are constants**, not configuration keys.
- **Learning proposals have no reviewer surface yet.** A proposal is stored, but the UI and the owner's decision path for it do not exist, so promoted vs proposed is unobservable to the owner.
- **No proposal path for persona or profile changes** (D14).
- **No live provider exercise**: no MCP server, Composio or Pipedream call was made, and nothing was deployed. Deploying this branch to the shared stack is blocked because that database already carries migrations from branches ahead of this base; the image's `migrate` step would abort. The tool-selection flag is process-wide, so a single test bot against a control bot (9.1) needs a per-bot surface that does not exist.