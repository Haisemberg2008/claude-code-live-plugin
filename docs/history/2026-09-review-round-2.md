# Independent review round 2 — blocking findings

Decision: not ready. Fix every P1 and P2 below with focused regression tests, then rerun the full verification. Do not weaken security or merely change tests to accept unsafe behavior.

## P1

1. `runtime/src/worker/session.ts` omits `authorizedModels` from the action context. `classifyDelegation` only checks a delegated model when that property exists and does not enforce delegated effort. Pass the closed model set and require xhigh/Extra before delegation.
2. A CLI handshake with `hooksApplied: false` is logged but does not block prompt delivery. The PreToolUse hook is a security gate; fail preparation closed before any work starts.
3. `process-tree.ts` treats a recent heartbeat plus live PID as process identity and later kills `engine.pid` by liveness alone. A recycled PID must never be terminated. Use an OS-verifiable creation identity when available; otherwise quarantine without killing.
4. When the worker is absent but the engine survives, startup reconciliation can release the checkout. Reconcile the engine independently and do not claim clean merely because two recorded PIDs are absent without proving descendants are gone.
5. `acknowledgeReview` can replace a quarantined lock without proving cleanup. Artifact review and ownership release must be separate; never restore a writer while a survivor is possible.
6. Failure to persist authoritative `current-run.json` is treated as telemetry. It must fail the launch before work is released.
7. The singleton can delete a newly created but not-yet-written lock during the `openSync('wx')` to owner-write window. A missing/unreadable owner is not proof of a stale lock.
8. `SessionClient` ends its queue on child `exit` before stdout is drained, and worker finalization ignores exit code/signal. Drain stdout first and distinguish requested close from crash; never report COMPLETED/CANCELLED falsely.
9. Model change is not serialized with the next turn. Reserve the transition and await worker confirmation before accepting/delivering the next message; refusal must leave the old model explicit.
10. Streaming redaction only looks back 4096 characters. Track open credential candidates across arbitrary chunk boundaries so very long JWT/userinfo/key/private-key candidates cannot leak prefixes.

## P2

11. Event history and SSE replay accumulate all events before applying limits. Enforce event/byte budgets during reads and replay buffering.
12. Global cursor reconnection can report a false gap after filtering a fully current client, while the dashboard only requests the latest 2000 rows. Compute gaps against the requested task cursor and support backward pagination without erasing valid history.
13. MCP caches broker address/secret forever. On a connection failure, rediscover for safe reads; for mutations with uncertain delivery, surface uncertainty and require explicit retry rather than replaying automatically.
14. `.codex-plugin/plugin.json` still displays OpenAInthropic and references deleted icons. Set visible brand to CodeOrquestra and point all icons to `assets/codeorquestra-icon.png`. Keep only deliberate legacy technical aliases.

## Mechanical cleanup already performed by Codex integration

The two obsolete SDK files were deleted, the three image assets were renamed to `codeorquestra-*`, and the two README image links were updated. Verify these results; do not recreate legacy files or names.

