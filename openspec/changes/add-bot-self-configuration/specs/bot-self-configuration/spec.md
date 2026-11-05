# Spec Delta

## Purpose

Let a bot use the configuration it is given — selected skills, learning, memory and proactive behaviour — while keeping constitution-level changes under owner control.

## ADDED Requirements

### Requirement: Explicit skill selection is usable
When a bot profile selects skills explicitly, the runtime SHALL offer only those skills, and legacy library mode SHALL remain available for bots without an explicit selection.

#### Scenario: Explicit selection is enabled
- **WHEN** a profile sets `skills.mode` to explicit with a list of skill ids
- **THEN** the run's skill library contains exactly those skills, and reading an unassigned skill fails

#### Scenario: Existing bot has no profile
- **WHEN** a bot has never been given a profile
- **THEN** its skill behaviour is unchanged

### Requirement: Learning promotion is scheduled, bounded and reviewable
The system SHALL run skill and memory promotion on a schedule using the bot's configured learning policy, and SHALL default to proposals-only. Automatic promotion SHALL require both the automatic mode and a recorded owner decision. Judgement of whether a candidate is worth promoting SHALL use a versioned rubric with an explicit reviewer prompt, and a judge failure SHALL produce an unqualified candidate rather than a pass.

#### Scenario: Proposals-only bot completes work
- **WHEN** a review window closes for a bot in proposals-only mode
- **THEN** candidates are recorded for owner review and no skill or memory is changed

#### Scenario: The judge errors
- **WHEN** the reviewing model call fails
- **THEN** the candidate is recorded as unqualified, is retried within the configured limit, and is never promoted on the failure

### Requirement: Memory corrections invalidate facts instead of deleting them
Memory SHALL support fact-level validity so a correction supersedes an earlier fact while the earlier fact remains auditable. Injected memory SHALL continue to be presented as data rather than instructions.

#### Scenario: A fact is corrected
- **WHEN** a new fact contradicts an existing one
- **THEN** the earlier fact is marked invalid from that point, the new fact is valid, and both remain readable in history

#### Scenario: Superseded fact is retrieved
- **WHEN** retrieval matches an invalidated fact
- **THEN** it is not injected as current knowledge

### Requirement: Proactive behaviour has real sources and a bound decision step
Proactive events SHALL be produced by configured sources in addition to inbound webhooks, including scheduled routines. A judge SHALL be bound where the bot's configuration enables one, and a judge error SHALL NOT drop an event. When a bot is already working, an incoming event SHALL be steered into the active run rather than queued behind it, and that condition SHALL reflect the bot's real state.

#### Scenario: A routine becomes due
- **WHEN** a configured routine reaches its time
- **THEN** an event enters the proactive pipeline and can produce a wake subject to the bot's limits

#### Scenario: An event arrives while the bot is working
- **WHEN** the bot has an active run
- **THEN** the event is steered into that run instead of producing a duplicate run

### Requirement: Constitution remains owner-controlled
A bot SHALL NOT write its own persona, instructions or constitution. It MAY propose a diff for owner approval, and every applied constitution change SHALL be recorded with the approving actor.

#### Scenario: A bot decides its persona is wrong
- **WHEN** a bot concludes its persona should change
- **THEN** it produces a proposal, and the stored persona is unchanged until an owner approves
