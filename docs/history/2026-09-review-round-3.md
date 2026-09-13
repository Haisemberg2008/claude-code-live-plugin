# Independent review round 3 — remaining blockers

Decision: not ready. Fix all findings below with deterministic regression tests and cleanup. Do not weaken fail-closed behavior or merely adjust expectations.

## P1

1. `process-tree.ts` treats any `engine.exitedAt` as proof that the full engine tree is gone. A parent exit, especially by crash/signal, does not prove descendants exited. `survivorCheck` must not ignore the tree merely because the parent recorded exit. Prove descendants are gone or quarantine; the fake must not mask this by cleaning children itself.
2. Streaming redaction discovers a new candidate only in the last 4096 characters of a chunk. A first single chunk containing an incomplete URL userinfo/JWT/key candidate longer than that can publish its prefix before candidate tracking begins. Scan every new chunk incrementally or use a streaming recognizer independent of chunk size, with bounded memory and no prefix leak.
3. Singleton stale-lock recovery is a read/delete race. Two contenders can observe the same old owner; A deletes and creates a new lock, then B deletes A's lock using stale evidence. Recovery needs atomic exclusion/ownership validation, not read-then-delete.
4. Broker shutdown does not cancel or await `prepareAndSpawn`. A preparation can create a worker after the shutdown worker sweep, while HTTP actions remain accepted. Reject new actions immediately, cancel/await preparations, then close workers/logs and release singleton.

## P2

5. A model-change timeout is treated as proof that the old model remains and queued turns resume. The CLI could have applied the switch and lost/delayed confirmation. Mark the model/run uncertain, block future turns until explicit recovery/restart, and never assert which model is active without confirmation.
6. `EventLog.load()` keeps up to 5000 full records without a byte budget, and `sse-hub.ts` buffers replay without a byte/event budget. Enforce limits while accumulating in both places.
7. MCP invalidates the cached broker only after GET failures. `list`, `wait`, and all actions first use idempotent POST `/tasks/by-handle`; when that fails they stay bound to the old port. Treat handle resolution as an idempotent lookup eligible for rediscovery; never automatically replay the later mutation if delivery is uncertain.
8. If stdout closes, exit status remains unknown after the grace period, and the turn is idle, worker shutdown can report COMPLETED while the CLI is still alive. This must be FAIL/UNCERTAIN, never confirmed completion.
9. `process-tree.test.ts` leaves a bystander grandchild with `setInterval` alive. Track parent and descendant identities and terminate/await both in `finally`; every test that spawns a tree needs deterministic cleanup even on assertion failure. Add a test proving the production does not treat parent exit as full-tree cleanup.

