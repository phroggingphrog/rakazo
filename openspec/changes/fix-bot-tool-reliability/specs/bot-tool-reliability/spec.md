## ADDED Requirements
### Requirement: Bounded retrievable output
The system SHALL disclose truncation and provide bounded, encrypted, expiring retrieval when it retains a full result. It SHALL reject unauthorized retrieval and enforce owner, space, bot and run isolation.
#### Scenario: Large result
- **WHEN** a redacted tool result exceeds the preview limit
- **THEN** the system returns explicit byte counts and a scoped retrieval receipt, or an explicit size-limit failure
#### Scenario: Wrong owner
- **WHEN** another owner uses a retrieval receipt
- **THEN** the system refuses retrieval without revealing the result
### Requirement: Bounded no-progress handling
The system SHALL stop repeated equivalent failures after a bounded number of attempts. It SHALL preserve cancellation and distinguish transient failures from permission and configuration failures.
#### Scenario: Permanent failure repeats
- **WHEN** a permission failure repeats without changed arguments or new evidence
- **THEN** the system refuses another identical execution with a specific recovery step
#### Scenario: Genuine progress
- **WHEN** corrected arguments produce a successful result
- **THEN** the system does not treat that result as a repeated failure
### Requirement: Disabled model escalation
The system SHALL NOT enable new model escalation without an owner-named and approved model.
#### Scenario: No model approved
- **WHEN** no escalation model has been approved
- **THEN** the system reports the blocker without switching models
