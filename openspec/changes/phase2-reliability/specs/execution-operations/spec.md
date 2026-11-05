## ADDED Requirements
### Requirement: Observable server-owned execution
The system SHALL expose durable execution status, attempts, interventions and evidence through shared contracts and existing clients, independently of mobile activity.
#### Scenario: Mobile closes
- **WHEN** the mobile client closes during execution
- **THEN** server execution continues and history remains available after reconnect
### Requirement: Independent recovery and honest measurement
Existing host supervision SHALL perform bounded deterministic recovery and escalation independently of Pi. Reliability reports SHALL use actual observation and explicit denominators.
#### Scenario: Repeated service failure
- **WHEN** safe restart attempts fail repeatedly
- **THEN** recovery stops looping, retains sanitized diagnostics and alerts the owner
#### Scenario: Observation incomplete
- **WHEN** fewer than seven actual days have elapsed
- **THEN** reports state incomplete observation and do not claim seven-day reliability
