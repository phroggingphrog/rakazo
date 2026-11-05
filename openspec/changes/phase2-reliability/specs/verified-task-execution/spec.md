## ADDED Requirements
### Requirement: Durable lifecycle and verified effects
The system SHALL persist task identity, execution state, bounded recovery metadata and independently checkable completion evidence outside model context. Unknown remote commits SHALL require reconciliation before replay.
#### Scenario: Interruption after remote effect
- **WHEN** execution restarts after an effect may have committed
- **THEN** it reconciles the destination before repeating and does not report verified completion without evidence
#### Scenario: Invalid authentication
- **WHEN** credentials cannot be refreshed automatically
- **THEN** execution persists an intervention request and stops invalid-auth retries

### Requirement: Trusted no-dispatch effect classification
The system SHALL classify an action as not dispatched only from a trusted internal pre-dispatch boundary, with the original result and approval history persisted under the current fenced run lease. Connector output and unclassified historical failures SHALL NOT establish that an external action had no effect.

#### Scenario: Rejected before dispatch
- **WHEN** a trusted local check rejects an action before any side-effect request is dispatched
- **THEN** its rejection is retained with its approval history, while any required destination obligation remains unresolved until validly satisfied or changed by the owner
#### Scenario: Untrusted or ambiguous failure
- **WHEN** a connector reports an error or a request may already have been dispatched
- **THEN** the result cannot mark the action as proven not dispatched and remains conservative until independently reconciled
#### Scenario: Stale worker and approval replay
- **WHEN** a superseded worker attempts classification or an already classified approval is replayed
- **THEN** the stale write is fenced and the replay returns its recorded outcome without re-executing the action
#### Scenario: Unrelated later success
- **WHEN** an action fails before dispatch and another action succeeds at a different destination or for a different obligation
- **THEN** the unrelated success does not satisfy the original required obligation

### Requirement: Durable routine completion notifications
The system SHALL record each eligible routine completion notification independently of run completion. Intent creation SHALL be atomic with finalizing the run and user-visible message and use a unique key per intent. Workers SHALL use fenced claims and recover unfinished work after interruption.

#### Scenario: Crash after routine finalization
- **WHEN** a process stops after finalizing an eligible routine run but before notification submission
- **THEN** the committed notification intent remains pending and a worker can resume it without creating a second intent
#### Scenario: Concurrent workers and stale claims
- **WHEN** multiple workers compete for a pending intent or a worker resumes after its claim has been superseded
- **THEN** only the current fenced claimant may submit or change the outcome, and an abandoned claim is recovered without assuming an in-flight request was not sent

### Requirement: Safe notification outcomes
The system SHALL distinguish pending, in-flight, provider accepted, confirmed failure, unavailable recipient and uncertain submissions. An ambiguous submission SHALL NOT be repeated without verified provider idempotency or reconciliation for the same intent.

#### Scenario: Unknown provider outcome
- **WHEN** a connection drops or the process stops after submission may have reached the provider but before acceptance is recorded
- **THEN** the intent remains uncertain and is not automatically sent again without verified provider idempotency or destination reconciliation
#### Scenario: Definite rejection or absent recipient
- **WHEN** a provider confirms rejection or no eligible push recipient exists
- **THEN** the recorded outcome identifies the failure or unavailable recipient and the run is not described as having delivered a notification

### Requirement: Notification evidence
The system SHALL report provider acceptance and receipt as separate evidence. A completed run SHALL NOT be presented as notification delivery, and provider observations SHALL NOT be represented as proof that a person saw a notification.

#### Scenario: Provider acceptance and receipt
- **WHEN** a provider accepts a notification and later returns a receipt
- **THEN** both observations are retained as distinct outcome evidence without claiming the device displayed it or that the owner saw it

### Requirement: Notification privacy
Notification intent and recovery SHALL preserve tenant isolation and preferences, store minimal authorized references, and protect message content and credentials.

#### Scenario: Notification privacy and preferences
- **WHEN** an intent is persisted or recovered
- **THEN** it remains scoped to its owner, honors the applicable preference and protected content access, and does not expose notification text or credentials through operational data

### Requirement: Deterministic trigger precedence
The system SHALL process direct requests and due timers before discretionary model judging.
#### Scenario: Judge configured first
- **WHEN** a due timer arrives with judge first in configuration
- **THEN** the deterministic timer decision is not suppressed by the judge
