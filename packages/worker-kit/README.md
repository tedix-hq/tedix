# @tedix/worker-kit

Small, direct-import primitives shared by Tedix Cloudflare Workers. The package
owns transport-edge mechanics, not application policy:

- `@tedix/worker-kit/request-auth` — trusted service-binding detection, Bearer
  parsing, inbound trust-header hygiene, and timing-safe shared-secret
  comparison. This is the single Bearer parser for Worker request edges;
  application and identity packages do not keep local copies.
- `@tedix/worker-kit/cors` — reusable MCP CORS constants and strict origin
  matching.
- `@tedix/worker-kit/errors` — consistent JSON 404/500 handling for Hono
  Worker entrypoints.
- `@tedix/worker-kit/crypto` — `sha256Hex`, `timingSafeEqual`,
  `deriveHkdfHmacKey`, `hmacSha256`: the single owners of the Web Crypto
  one-liners Workers used to copy per file. Base64url lives in
  `@tedix/auth/utils`.
- `@tedix/worker-kit/sleep` — plain `sleep(ms)`. Abortable or clamped variants
  stay with their callers.
- `@tedix/worker-kit/error-message` — `errorMessage(error)`: `error.message`
  for an `Error`, `String(error)` otherwise. Variants that walk `cause` or
  substitute fallback text stay with their callers. Record guards
  (`isRecord`, `asRecord`) live in `@tedix/api-contract/utils/is-record`.

Import these subpaths directly; the package has no root barrel.

## Logger (`@tedix/worker-kit/logger`)

Typed structured logger for Tedix Workers. Its reason to exist is a type, not a
feature: **logging a secret is a compile error.**

## The prohibition

`ReservedLogField` names twelve fields. `ProhibitedFields` re-types every one a
caller declared as `?: never`, so supplying a value for it fails to typecheck:

```ts
log.info("credential resolved", { event: "cred.resolved", token: accessToken });
//                                                        ^^^^^
// Type 'string' is not assignable to type 'undefined'.
```

Six of the twelve are secret-bearing (`body`, `header`, `headers`, `prompt`,
`secret`, `token`); six are emitter-owned (`component`, `error`, `errorStack`,
`exception`, `event`, `message`) and reserved so a caller cannot shadow the fields the logger
writes. `component`, `event`, and `error` are re-opened at exactly the call
sites that own them. When `error` is supplied, the logger keeps its existing
`error` and `errorStack` fields and adds a bounded `exception` object containing
type, message, stack, cause chain and aggregate errors. The shared Hono error
handler uses this logger for uncaught request failures. Other direct `console`
call sites do not inherit the structured shape until migrated.

`src/logger.test.ts` checks each prohibition with a `// @ts-expect-error` line,
so if the mapped type is ever weakened the _unused_ directive fails the build.

The type-level assertions are checked by `tsc`, not by Vitest:

```sh
bun run --filter @tedix/worker-kit type-check   # proves the prohibition bites
bun run --filter @tedix/worker-kit test:run     # proves the emission shape
```

## Public surface

One entrypoint, `@tedix/worker-kit/logger` (no barrel):

| Export                                             | Kind     | Purpose                                                               |
| -------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| `createLogger<Fields>({ component, ...defaults })` | function | Module-scoped logger. `component` is a stable dot-separated identity. |
| `Logger<Fields>`                                   | type     | `with()`, `debug()`, `info()`, `warn()`, `error()`.                   |
| `ReservedLogField`                                 | type     | The twelve prohibited names.                                          |
| `LogValue`                                         | type     | What a structured field may hold.                                     |
| `LogLevel`                                         | type     | `"debug" \| "info" \| "warn" \| "error"`.                             |

Each consumer declares its own field vocabulary and the logger is generic over
it, so a field name means the same thing everywhere in a package and nowhere
does an ad-hoc `Record<string, unknown>` leak in:

```ts
// apps/mcp/src/log.ts
export type McpLogFields = {
	appSlug: string;
	outcome: "ok" | "denied"; /* ... */
};
export const createMcpLogger = (component: string) =>
	createLogger<McpLogFields>({ component });
```

`with()` returns a new logger with extra fields; the parent is unchanged. Call
details override inherited fields; `component` never moves.

## Output shape

One `console[level]` call, one object argument, per log:

```json
{
	"component": "mcp.auth.cimd",
	"event": "cimd.blocked_domain",
	"cimdHost": "evil.example",
	"outcome": "denied",
	"message": "Blocked CIMD resolution"
}
```

Workers Logs promotes the object's own keys to queryable fields; Logpush
`workers_trace_events` → R2 carries it as
`logs[].message[0]`, queryable with Log Explorer or R2 SQL. The level is
deliberately **not** a field: `logs[].level` already records it, so adding one
would only create a name that could collide. The public
[workers and governance](../../docs/public/workers-and-governance.md) overview
describes what Tedix records.

Nothing is lost relative to `console.log("[Auth/CIMD] Blocked " + host)`. What is
gained is that `cimdHost` is a field you can group by instead of a substring you
have to regex out of prose.

## Logging plane vs analytics plane

These are two planes and this package is only one of them. Do not merge them and
do not route one through the other.

|             | **Logging** (this package)                      | **Analytics** (`apps/mcp/src/mcp/utils/analytics.ts`)      |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------- |
| Sink        | `console.*` → Workers Logs → Logpush → R2       | Analytics Engine (`tedix_analytics`) + D1 `audit_events`   |
| Retention   | 7 days hot, durable in R2 after Logpush         | AE retention; `audit_events` is immutable and permanent    |
| Sampling    | Unsampled at emit                               | **Sampled** — inner rows can be dropped                    |
| Unit        | A diagnostic line about _how the code behaved_  | A business event about _what a caller did_                 |
| Read for    | "Why did this request fail / take that branch?" | "How many tool calls, what latency, who ran it?"           |
| Cardinality | Free — arbitrary diagnostic fields              | Constrained by AE blob/double slots and the audit contract |
| Authority   | None. Never a compliance or billing record.     | `audit_events` is the authoritative who-did-what lane      |

Rule of thumb: if a dashboard, a service-level objective (SLO), or an audit answer depends on it, it is
an **event** and belongs in `trackMcpEvent` / `emitMcpAuditEvent`. If an on-call
engineer reads it while chasing a specific failure, it is a **log** and belongs
here. The table above is the exported contract for this package's split.

The two share a vocabulary on purpose. `apps/mcp/src/log.ts` reuses
`McpEvent["authType"]` from the analytics module so a log line and an analytics
row label the same caller identically — same names, different plane.

## Runtime neutrality

No Node globals, no Workers-only APIs — only `console`. It bundles into a Worker
and runs unchanged in a plain Node Vitest environment.

## Provenance

The logger's reserved-field type machinery is adapted from Cloudflare OS under
Apache-2.0; the exact source revision and license are recorded in
`THIRD_PARTY_NOTICES.md`. Two ambient-context pieces are deliberately omitted:

- The `AsyncLocalStorage`-backed `createObservabilityContext`. It requires
  `node:async_hooks`, which breaks the runtime-neutrality rule above, and its
  context does not survive RPC, hibernation, or Durable Object (DO) restart — the exact
  boundaries Tedix Workers are built out of. `with()` covers the cases that
  matter without an ambient store that quietly empties.
- The context-reading seam that exists only to serve that store.
