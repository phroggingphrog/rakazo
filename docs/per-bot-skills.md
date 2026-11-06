# Per-bot skills

Skills remain SKILL.md recipes in the existing shared library. Each bot's runtime profile
stores its persistent enabled IDs; legacy profiles keep the existing library until the
first selection change materializes an explicit catalog. Subsequent library additions
require discovery and enabling for that bot. Selection changes preserve every other
profile field and append the existing profile revision history under the bot lock.

- `skill_read` reads only enabled shared or own private recipes. `discover: true` and an
  optional `query` return available metadata (including disabled entries), never bodies.
- `skill_update` with `enabled` changes only the acting bot's selection, separately from
  content changes. The dispatch context supplies identity, not model arguments.
- `skill_create` creates an enabled private lesson. Bots cannot edit or delete shared,
  builtin, plugin or another bot's recipes. Create a separately named private lesson
  rather than changing shared instructions.
- Private updates retain prior SKILL.md snapshots and increase `revision` atomically.
  `skill_read` with `history: true` lists snapshots; `skill_update` with
  `rollbackRevision` restores one as a new revision. Deleted lessons are not restorable.
- Authenticated `bots/skillCatalog` returns enabled metadata by default, or available
  metadata with `discover: true`; `bots/skillSelect` uses the same scoped selection path.
  No frontend changes are required.

Skills do not change roles, credentials, approval policy or tool permissions. Existing
authorization still governs every operation. New selections appear in subsequent run
prompt assembly; tool reads enforce the current selection even during an existing run.
No automatic background lesson generator is introduced.

## Migration and rollback safety

The migration adds nullable bot ownership plus revision/history columns to `agent_skills`.
Shared rows retain null ownership and their existing behavior. Names are unique in the
shared namespace or within one private bot namespace. The owning bot's deletion cascades
private lessons. Shared-library API and availability controls exclude private lessons.

**Do not roll back to an ownership-unaware image while private rows exist.** Older
library resolvers do not filter `ownerBotId`, so rollback could expose private lessons to
other bots. Before enabling this release in production, prepare and verify an
ownership-aware rollback image, or use the tested transactional quarantine below. A plain
image-pin rollback is unsafe after the first private lesson is written. Do not drop
ownership/history columns to roll back.

### Reversible rollback to an older image

1. Back up the database and deployment config; keep the previous image. Stop **all**
   app services (API, worker, supervisor, web), leaving only PostgreSQL running. Confirm
   no app containers remain running before the transaction, so no private writes race it.
2. As database owner, run `psql -v ON_ERROR_STOP=1 -f scripts/quarantine-private-skills.sql`.
   This atomically archives complete rows (including history/files) and availability links
   in `skill_rollback`, a schema with no runtime grants, then removes them from the old
   resolver's table. Verify zero public rows have non-null `ownerBotId`. Do not start
   the old image if any command fails. Keep the archive and the database columns intact.
3. Change the single deployment image pin to the preserved old image and start the stack.
   Private lessons are unavailable until restored; shared rows and bot profile selections
   are unchanged. Do not delete bots/spaces while their lessons are quarantined.
4. To return forward, stop all app services again, pin the ownership-aware image, run
   `psql -v ON_ERROR_STOP=1 -f scripts/restore-private-skills.sql` as database owner, then
   start the stack. Conflicts or missing owners fail the entire restore rather than
   discarding data. The archive empties only after every row/link is restored.

The PostgreSQL integration test exercises both exact SQL files, repeated operations,
old-style query exclusion, runtime archive denial, and lossless revision/file/link restore.

Verification uses the existing offline skill tests and the PostgreSQL runtime-profile
integration harness: `pnpm test:integration --spec=bot-runtime-profiles`.
