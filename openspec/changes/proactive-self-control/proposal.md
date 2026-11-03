## Why
Rakazo already has a durable proactive engine, but does not expose its controls to bots or wire its semantic judge. The owner approved porting the useful pi-durable-bot behavior into this existing path, not a standalone service.

## What Changes
- Wire optional Jev decisions through the existing DecisionProvider.
- Add governed per-bot wake, timer, hook and policy configuration with audit and reset.
- Arm fallback wakes and feed sent messages back as events.
- Verify working-state and send-once behavior before changing delivery.

## Capabilities
### New Capabilities
- `proactive-self-control`: Bounded bot-owned proactive controls and durable event decisions.
### Modified Capabilities
None.

## Impact
Shared proactive core, adapters, bot tool dispatch, database and API/worker composition. No new dependencies or services. Rollout requires separate owner approval.
