## Context
The deployed API and worker use 1527ebd. Web uses 59adef5. Live assignments have changed since the previous investigation. Jobwatch now belongs to Job Watcher. Home Assistant reports an authentication failure. Existing sealed events must not expose private payloads during investigation.

## Goals / Non-Goals
Preserve isolation, credential encryption, imported STDIO restrictions and existing grants. Do not deploy, restart, rotate credentials, change assignments or select an escalation model.

## Decisions
Use encrypted artifact storage for full redacted tool results. Bind bounded expiring retrieval receipts to owner, space, bot and run. Reject oversize results explicitly. Keep previews valid UTF-8 and disclose all output limits. Check authorization again for tool calls and retrieval. Classify permanent permission/configuration failures separately from transient transport failures. Canonicalize failed request arguments without logging them. Bound equivalent failures and preserve cancellation.

## Risks / Trade-offs
Provider-side truncation cannot be reversed; disclose it. Expired object cleanup needs a bounded lifecycle. In-memory quotas alone do not provide durable quotas and must not be called sufficient. Runtime model fallback remains unchanged.

## Migration Plan
No live changes. Validate isolated fixtures and publish only a feature branch in phroggingphrog/rakazo. Keep importer work independent.

## Open Questions
The owner has not named an escalation model. Automatic escalation stays disabled.
