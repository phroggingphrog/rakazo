## 1. Baseline
- [x] 1.1 Audit existing deployment and record approved compatible design.
- [ ] 1.2 Preserve owner request on tracking card and diagnose Workspace prerequisite through existing path.
## 2. Execution hardening
- [x] 2.1 Reproduce and fix deterministic proactive stage precedence with regression tests.
- [ ] 2.2 Add durable lifecycle/intervention projection and bounded dependency retry policies.
- [ ] 2.3 Gate autonomous completion on destination evidence and reconcile uncertain effects.
- [ ] 2.4 Preserve compact task context, provenance and active-task retention.
- [ ] 2.5 Persist and recover routine completion notification intents and truthful provider outcomes, without blindly replaying ambiguous sends; cover crash, concurrency, preference, privacy and receipt boundaries.
  - Partial: notification intents, Expo receipt state and the bot preference-race fix are deployed; one earlier provider receipt was observed. Device display and the earlier missed reminder remain unverified.
  - Owner-initiated retry is implemented locally and passed isolated PostgreSQL race and authorization checks. An incremental Prisma rehearsal applied its single migration after 204 migration checksums matching production. The retry is not deployed; exact-release verification, shutdown and rollback remain open.
- [ ] 2.6 Make routine schedule changes and wake publication durable and generation-fenced across all producers, workers, cancellation and reconciliation; prove same-time rearm, stale publish/cancel, rollback and bounded cleanup with deterministic and isolated PostgreSQL/Graphile tests.
  - Partial: keyed publication and several stale schedule, watch and chat-creation races are addressed in the deployed release. Full rollback, cleanup and all-producer proof remain open.
## 3. Workflows and operations
- [ ] 3.1 Implement constrained email, calendar and subscription workflows on existing routines.
- [ ] 3.2 Expose shared monitoring, evidence/history and approval contracts across applicable clients.
- [ ] 3.3 Extend existing deterministic host supervision and escalation.
  - Partial: an observation-only check runs through the existing user cron service, and its scheduled health observations were recorded. Automatic recovery and external alert delivery remain unverified and disabled.
## 4. Validation and release
- [ ] 4.1 Run automated tests and controlled interruption, dependency, auth and provider failure scenarios.
- [ ] 4.2 Release one shared build through existing stack with backup and rollback, verify actual owner-facing behavior.
  - Local revision `e62a95435` was built without network and loaded into the existing image store. It is not deployed; the running build is `fab243c85`. Full shutdown/drain, rollback and authenticated owner-facing acceptance remain open.
- [ ] 4.3 Verify installed iOS status, approval resume and notifications or document concrete access limitation.
- [ ] 4.4 Establish actual seven-day metrics and daily summary, deliver operating/recovery guide.
  - Observation has not started: require authenticated owner-facing verification of the released build first, then seven actual consecutive days of evidence.
## Workflow follow-up
- Complete seven actual days of observation before making a seven-day reliability claim.

## 5. Autonomous agent workspace and self-configuration
- [ ] 5.1 Complete a code-referenced reuse and gap audit across existing navigation, clients, configuration and durable runtime.
- [ ] 5.2 Persist a typed setup plan and honest proposed, approval, configuration, verification, activation and failure states using existing configuration and authorization paths.
- [ ] 5.3 Deliver and test the complete email-monitor journey: purpose, existing integration discovery, prerequisite and read-permission review, persisted bot and routine, real test, verified activation and execution history.
  - Partial: the owner setup flow, conversational source-bound scheduling, current-policy checks, and an owner-triggered selective read grant are deployed. Setup wording is now source-neutral, with an offline synthetic calendar read tested and existing email drafts retained. The owner provided an authenticated screenshot reaching the earlier setup screen; no saved proposal or real provider source test has been verified in this session. The broader arbitrary-integration experience remains incomplete.
  - Local candidate adds simple schema-guided source argument controls on web and mobile, retaining JSON for complex inputs. Focused tests, typechecks and synthetic browser checks passed; device, screen-reader, authenticated-source, full UI delivery gate and release remain open.
  - A restricted-role, encrypted synthetic end-to-end fixture passed authentication, setup RPCs, an in-memory worker and one simulated MCP read, with the result reaching the scripted runtime and a paused routine. Graphile, real owner/provider, device and production verification remain open. The 89 previously missing task labels are now translated locally in seven mobile locales; the full mobile i18n coverage test passes.
- [ ] 5.4 Incrementally expose agent responsibilities, automations, tasks and delegation, integrations and system recovery using real supported state; preserve manual settings and explicitly identify unsupported actions.
  - Partial: the deployed code lets a bot request assignment of an existing owner integration, preserving credentials and restricted grants. Assignment does not establish provider readiness; authenticated UI verification and wider workspace capabilities remain open.
- [ ] 5.5 Verify applicable web, desktop and mobile flows, accessibility and responsive states, with component, integration and end-to-end coverage and actual owner-facing release verification.
