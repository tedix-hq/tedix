# @tedix/agent-governance-postgres

Postgres storage for the memory, accountability and compliance contracts in
`@tedix/agent-governance`. Each instance is bound to one trusted workspace scope.
All reads and writes include that scope.

Apply `migrations/0001_governance.sql` once to an empty database before use.
The caller owns the database connection and migration lifecycle.

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresAdapters } from "@tedix/agent-governance-postgres/adapters";

const adapters = createPostgresAdapters(drizzle(databaseUrl), {
	scope: workspaceId,
	facts: async (call) => resolveCurrentPolicyAndApproval(call),
});
```

The `facts` callback returns `ComplianceFacts` from the shared governance package.
Resolve scopes, policy, annotations, secret-egress rules and approval receipts
there. Without a callback, call annotations supply the classification and
unapproved destructive calls are held. The adapter consumes the shared risk-tier
budget in Postgres, then runs `evaluateCall`. Rate windows survive adapter
recreation and are shared across connections in the same storage scope.

Memory values and provenance are stored as JSON. Writes append a revision;
review atomically changes a pending revision once. Rollback appends a new
revision containing the target value and provenance of the rollback actor.
The newest approved revision remains available alongside the current revision.

The change ledger has no update or delete API. Scope-local sequence allocation
and insertion are one statement, serialized on a scope head row, so concurrent
commits cannot appear behind a consumer's sequence cursor. Memory allocation
and insertion are also one statement. Compliance outcomes store an argument
hash, classification and outcome; raw call arguments are omitted. The caller
must redact sensitive outcome results and errors before recording them.

`bun run --cwd packages/agent-governance-postgres test:run` starts an isolated
Postgres 17 Docker container on a random loopback port, applies the migration,
runs identical contract exercises against the in-memory and Postgres adapters,
and checks persistence, concurrency and scope isolation. The test closes its
pool and removes its container. Docker must be available locally and in CI.
`test:ci` runs the same suite without a fallback or skip.
