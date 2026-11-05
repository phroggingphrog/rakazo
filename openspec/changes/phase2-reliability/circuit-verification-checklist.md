# Circuit verification handover

Implementation is in progress; this checklist does not certify it.

Use the approved disposable PostgreSQL instance only, never production for concurrency fixtures. Exercise the actual DependencyRetry SQL using independent database clients. Race two claims for identical dependency/server/space/user/revision and assert exactly one token wins. A different identity must remain eligible. Advance controlled time past lease expiry; old-token success/failure must update zero rows after a new token wins. Assert cooling deadline rejects admission across recreated helper instances and exhaustion remains persisted. New revision is eligible independently; old revision completion cannot alter new revision. Verify cancel/install release does not increment failure count.

Run the new additive migration on the pre-circuit fresh-schema baseline and inspect primary key/defaults. Prior 201-file migration evidence does not include this new table. Record raw affected-row outcomes and test exit status. Mocked SQL tests alone are insufficient.
