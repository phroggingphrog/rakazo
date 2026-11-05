# Spec Delta

## Purpose

Give each bot private memory with provenance and a gated path into shared memory that never lets a bot write a shared bank directly.

## ADDED Requirements

### Requirement: Facts carry provenance
Every fact a memory commit adds SHALL record its bot, Space, memory level, logical bank, source run, thread and message, method and confidence when known.

#### Scenario: A bot remembers a fact
- **WHEN** a bot calls `remember` without a source
- **THEN** the stored fact has method bot-inferred and the bot's private bank id

### Requirement: Corrections supersede instead of deleting
`remember` with `replaces` SHALL invalidate the quoted fact and link the new fact to it, and SHALL fail without writing when the quoted fact is absent.

#### Scenario: Correcting a fact
- **WHEN** a switched-on bot remembers "X" replacing "Y"
- **THEN** "Y" is kept with an invalidFrom time and "X" points to it as superseded

### Requirement: Sharing is opt-in and never a direct write
The effective share level SHALL be off unless the bot is on the per-bot switch and its profile sets `learning.share`; no share level SHALL write to a shared bank directly.

#### Scenario: All bots on the switch, no opt-in
- **WHEN** the switch names every bot and a profile leaves `learning.share` unset
- **THEN** that bot's share level is off
