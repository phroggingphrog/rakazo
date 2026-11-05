# Proposal

## Why

The owner asked for a bot that configures itself: it selects the tools relevant to a turn from a pooled catalog (built-in tools, MCP servers, installed capabilities, Composio apps), wires them to itself, and decides what it writes into its own memory. Deep research on Grok Bot and Hermes (this session, 2026-11-04) established that the installed Rakazo fork at commit `e0386c3` already ships every primitive — self-installing MCP servers, self-written memory and skills, a tested proactive engine — but three seams are missing or blocked:

1. **No relevance selection.** The run's tool list is assembled once at `packages/adapters/src/executor.ts:1253-1254` and passed once at `:1622`. Nothing ranks, filters by relevance or budgets that list. The only count controls are a lazy catalog (`lazy-tool-catalog.ts`, `DIRECT_TOOL_LIMIT=20` plus three meta-tools) and a deferred bridge (`builtin-tool-bridge.ts:21-52`, 30 core tools always visible, the rest behind `find_tool` with `FIND_TOOL_LIMIT=3` grouped into nine keyword areas). With 27 MCP servers and 50 bot bindings live, that is already the binding constraint.
2. **The profile the bot would configure is blocked at the API.** `apps/api/src/routes/bot-runtime-profile.ts:16` sets `SUPPORTED_CAPABILITIES = ["persona"]` and the route answers "not available yet" for explicit skill selection, learning, initiative and routing. `skill-tools.ts:32-83` already enforces `skills.mode=explicit`; `automaticLearningPromotionDecision` (`packages/core/src/bot-profile-policy.ts:58`) already exists with zero callers. Live `bot_runtime_profiles` row count: 0.
3. **Proactivity has no real sources and no judge.** The engine, its 10 conformance invariants and its Postgres store are live for every bot (`PROACTIVE_WEBHOOK_BOTS=*`), but the only source is the inbound webhook, the Judge port is unbound (`packages/adapters/src/proactive.ts:222`) and the steer branch is dead because `RakazoWakeTarget.isWorking()` returns hard-coded false (`proactive.ts:158-160`). Live `proactive_events`: 0.

This change supplies those three seams and enables the profile capabilities already specified, without building a second execution authority and without copying Hermes' router (embedding-based retrieval in `jev-skill-router`, which ToolACE-MCP shows is the weak link once a catalog grows).

## What Changes

- **Capability index and per-turn selection.** Add a durable, space-scoped index of every discoverable tool (built-in, remote MCP, installed capability, Composio/Pipedream connector) built from the fan-in points that already exist, and a bounded top-k selection step that runs after the existing rule-based filter and before the single assembly site. Owner-started runs keep the full list. Selection never changes mid-run.
- **Make the profile effective.** Enable explicit skill selection, learning-proposal promotion behind a nightly job, and fact-level memory supersede, reusing the profile contract, the resolution path and the revision tables that already exist. Constitution files (persona) remain owner-gated.
- **Land proactive wiring.** Merge or re-derive the approved `feat/proactive-self-control` work (two commits past the deployed image, containing judge binding and bot self-control), feed routines in as a first-class event source, and make `isWorking()` report the truth so the steer branch can fire.

## Impact

- Affected specs: `bot-tool-selection` (new), `bot-self-configuration` (new). Depends on `add-governed-bot-runtime-profiles` for the profile contract, capability policy, learning lifecycle and memory governance; this change advances that change's tasks 4.3, 6.x, 7.x and 8.x rather than restating them.
- Affected code: `packages/adapters` (executor, tool assembly, selection, proactive wiring), `packages/core` (selection index, learning promotion), `packages/db` (index tables, fact revisions), `apps/api` (profile route, jobs), `apps/worker` (nightly learning job).
- Live-data risk: read-only research found 5 bots, 27 MCP servers, 50 bot bindings, 14 memory documents, 14 routines and 0 profile rows in the deployed database. Indexing must be additive and backfillable; selection must degrade to today's behaviour on any index miss.
- Public-repository rule: this repository is public, so no local paths, hostnames or account identifiers may appear in these artifacts, in commits or in PR text.
- No deployment in this change without separate owner approval.
