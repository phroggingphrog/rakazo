## ADDED Requirements

### Requirement: Optional semantic decision
The runtime SHALL support an opt-in provider-neutral judge backed by Jev using existing credentials. Judge failures SHALL remain unqualified and follow the engine retry/wake path.
#### Scenario: Missing credentials
- **WHEN** no decision credential is configured
- **THEN** existing no-judge behavior remains unchanged

### Requirement: Governed self control
Bots SHALL set and cancel durable timers, schedule their next wake and register event hooks only for their own scope. Self-set wakes SHALL enforce a five-minute minimum and twenty-per-day maximum. Configuration SHALL be versioned, audited and resettable; only owners SHALL change decision order.
#### Scenario: Timer lifecycle
- **WHEN** a bot sets a permitted timer
- **THEN** it survives restart and fires once or is cancelled by that bot

### Requirement: Durable lifecycle integration
Enabled bots SHALL receive fallback scheduling on enable/startup. Sent messages SHALL re-enter the event log with stable identifiers without creating response loops. Working state and outgoing reconciliation SHALL be checked before claiming send-once delivery.
#### Scenario: Sent feedback
- **WHEN** an already-recorded sent message is observed again
- **THEN** it does not wake the bot or create a duplicate event
