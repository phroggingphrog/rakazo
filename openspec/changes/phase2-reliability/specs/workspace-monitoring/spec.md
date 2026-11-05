## ADDED Requirements
### Requirement: Conservative scheduled workflows
The system SHALL use persistent existing routines for conservative email organization, read-only calendar change/conflict monitoring and provenance-aware subscription reminders. Ambiguous or destructive actions SHALL require approval; permanent deletion SHALL never occur.
#### Scenario: Protected communication
- **WHEN** a message concerns important financial, academic, employment or security records
- **THEN** unattended organization preserves it and requests approval where ambiguous
#### Scenario: Calendar or renewal deadline
- **WHEN** an event changes or a known renewal approaches
- **THEN** a report identifies evidence and verified versus estimated dates without modifying events or subscriptions
