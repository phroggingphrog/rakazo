# Spec Delta

## Purpose

Give each run a bounded, relevant tool list chosen from the pooled catalog — built-in tools, remote MCP servers, installed capabilities and connector apps — without weakening the policy boundaries that already decide which tools a bot may use.

## ADDED Requirements

### Requirement: Selection runs after policy, never before it
Tool selection SHALL run on the set that survives existing authorization: `disabledBuiltinTools`, per-bot MCP bindings and `allowedTools`, run-trigger gates, and capability policy. Selection SHALL NOT re-admit a tool that the policy filter removed, and SHALL NOT widen an allowlist.

#### Scenario: A disabled tool is highly relevant
- **WHEN** the most relevant tool for a turn is disabled for that bot
- **THEN** it does not appear in the run's tool list, and selection returns no substitute tool of the same authority

#### Scenario: Selection disagrees with the allowlist
- **WHEN** the index contains a tool the bot's server assignment does not allow
- **THEN** the tool is excluded before ranking, and excluding it costs no additional provider call

### Requirement: Selection is bounded and deterministic
A non-interactive run SHALL receive a bounded tool set defined by a configurable maximum count and token budget. Given the same index revision, policy set and request, selection SHALL produce the same list. Selection SHALL complete without a network call on the run's critical path.

#### Scenario: Catalog far exceeds a practical tool count
- **WHEN** a run's candidate set holds several hundred tools
- **THEN** the run receives at most the configured maximum, and the recorded selection explains which signal ranked each chosen tool

#### Scenario: The index is unavailable
- **WHEN** the index cannot be read
- **THEN** the run proceeds with the unfiltered candidate set exactly as today, and a fallback counter is recorded

### Requirement: Interactive runs keep the full set
Owner-started runs SHALL receive the complete post-policy tool set. Selection SHALL apply to scheduled, background, routine, webhook-driven and delegated runs.

#### Scenario: Owner starts a chat
- **WHEN** the trigger is an owner-initiated message
- **THEN** the tool list is unchanged from current behaviour

### Requirement: The selected set is frozen for the run
The tool list SHALL be computed once per run and SHALL NOT change while that run executes. Additional tools SHALL remain reachable only through the existing `find_tool` and `use_tool` bridge.

#### Scenario: The model needs a tool that was not selected
- **WHEN** the model calls `find_tool` for a deferred tool that policy allows
- **THEN** it receives it without the run's visible tool list being rebuilt

### Requirement: The index is derived, not a second source of truth
The index SHALL be derived from the sources that already own tool discovery, and SHALL NOT introduce a persistent catalog that can disagree with them. Rebuilding it from the sources SHALL reproduce the same set.

#### Scenario: A source changes
- **WHEN** a server gains or loses a tool
- **THEN** the next rebuild reflects it without a data migration or a manual repair step

### Requirement: Entries carry provenance and a grace window
Every index entry SHALL record its source kind, source identifier, space, bot binding where applicable, offered tool name, a description digest, and the time the source last confirmed it. An entry past its freshness window SHALL be withheld from selection. A single failed enumeration SHALL NOT remove it; it SHALL stay usable through a grace window.

#### Scenario: A server stops offering a tool
- **WHEN** an MCP server's latest probe no longer lists an indexed tool
- **THEN** that entry is withheld, and the run does not receive a tool that would fail at call time

#### Scenario: A probe fails transiently
- **WHEN** confirmation fails because the server is unreachable once
- **THEN** the entry stays usable through the grace window and is retried on the next probe cycle

### Requirement: Source coverage includes live-only providers
The index SHALL accept entries from sources that have no local persistent record, including connector providers resolved live, and SHALL remain correct when such a provider is unreachable.

#### Scenario: A live connector provider is down
- **WHEN** a connector provider cannot be enumerated
- **THEN** its previously indexed entries are withheld rather than treated as removed, and the rest of the catalog still indexes

### Requirement: Degradation is observable
The system SHALL record, per run, whether selection ran, how many candidates were considered and chosen, and any tool the model requested through the bridge that was withheld by policy or missing from the catalog.

#### Scenario: Quality drops after enabling selection
- **WHEN** a reviewer inspects recent runs
- **THEN** they can see the chosen tool count, the fallback rate, and how often the model asked for a tool that was not offered
