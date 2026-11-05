-- A protected task carries only a benign placeholder in the space-visible row.
ALTER TABLE "tasks" ADD COLUMN "protected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_protected_prompt_check" CHECK (
  NOT "protected" OR "prompt" = 'Protected task; execution is unavailable.'
);
CREATE UNIQUE INDEX "tasks_id_protected_key" ON "tasks" ("id", "protected");

-- Until worker fencing is verified, old and new workers cannot receive a run
-- attached to a protected task. The composite FK serializes conflicting writes.
ALTER TABLE "runs" ADD COLUMN "taskProtected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "runs" ADD CONSTRAINT "runs_protected_execution_disabled" CHECK ("taskProtected" = false);
ALTER TABLE "runs" ADD CONSTRAINT "runs_taskId_taskProtected_fkey"
  FOREIGN KEY ("taskId", "taskProtected") REFERENCES "tasks" ("id", "protected")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "protected_execution_content" DROP CONSTRAINT "protected_execution_content_no_task_yet";
ALTER TABLE "protected_execution_content" ADD CONSTRAINT "protected_execution_content_parent_check" CHECK (
  ("routineId" IS NOT NULL AND "taskId" IS NULL) OR ("routineId" IS NULL AND "taskId" IS NOT NULL)
);
ALTER TABLE "protected_execution_content" ADD CONSTRAINT "protected_execution_content_task_fkey"
  FOREIGN KEY ("taskId", "protected") REFERENCES "tasks" ("id", "protected")
  ON DELETE CASCADE ON UPDATE RESTRICT;
DROP POLICY protected_execution_content_tenant ON "protected_execution_content";
CREATE POLICY protected_execution_content_tenant ON "protected_execution_content"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND (
      EXISTS (SELECT 1 FROM routines r WHERE r.id = "protected_execution_content"."routineId"
        AND r."spaceId" = "protected_execution_content"."spaceId" AND r."userId" = "protected_execution_content"."userId" AND r."protected")
      OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = "protected_execution_content"."taskId"
        AND t."spaceId" = "protected_execution_content"."spaceId" AND t."userId" = "protected_execution_content"."userId" AND t."protected")
    )
  );
