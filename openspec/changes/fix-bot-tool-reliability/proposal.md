## Why
Bots report permission failures, connection failures and incomplete output without enough evidence to recover. Repeated equivalent failures waste work without correcting the cause.

## What Changes
- Preserve bot-specific grants and classify actionable failures.
- Add bounded encrypted output retrieval with explicit truncation metadata.
- Stop equivalent failing requests after bounded attempts, with cancellation support.
- Diagnose API and worker paths without changing live assignments.
- Keep model escalation disabled until the owner names and approves a model.

## Capabilities
### New Capabilities
- `bot-tool-reliability`: safe output retrieval and no-progress handling.
### Modified Capabilities
None.

## Impact
MCP connector, runtime dispatch, output storage and regression tests. No deployment or permission expansion is authorized.
