---
sidebar:
  order: 130
title: "Cloudflare architecture"
topic: "Platform"
resource_type: reference
description: "The Cloudflare primitives behind Tedix digital workers."
summary: "Public overview of the Tedix Cloudflare-native architecture"
read_when:
  - Evaluating the Tedix deployment model
  - Understanding how Tedix uses Cloudflare
visibility: public
---

# Cloudflare architecture

Tedix is built on Cloudflare so digital workers can combine low-latency edge
execution with durable state and bounded access to heavier compute.

## One request through Tedix

A Home request follows this path: request → authority and routing → optional
tool work → result → continued context.

| Step                          | What happens                                                                                                                                                 | Source to explore                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Submit                        | The CLI sends one durable Home turn and recovers that exact submission after an uncertain response.                                                          | `packages/cli/src/home-submission.ts`                                                                        |
| Admit and route               | The API checks organization/conversation access, records the request, and routes it to a Home answer or delegated work.                                      | `apps/api/src/rpc/routers/kernel-runtime/execution-proposals.ts`, `apps/api/src/rpc/routers/kernel/index.ts` |
| Use a capability, when needed | Home may answer without a capability. When it uses one, MCP enforces tool scopes and connection boundaries; protected actions follow their approval path.    | `apps/mcp/src/mcp/handler.ts`, `apps/api/src/rpc/routers/kernel-runtime/approval-control.ts`                 |
| Inspect the result            | Home exposes the parent run and any delegated branches; a recorded completion is an execution outcome, not independent validation.                           | `apps/api/src/rpc/routers/kernel/home-run-trace.ts`                                                          |
| Continue                      | The next turn assembles bounded conversation history and eligible context. Persistent conversation records are distinct from selected organizational memory. | `apps/api/src/rpc/routers/kernel/context-assembly.ts`, `packages/db/src/queries/kernel-conversations.ts`     |

OS and CLI conversations use Home/kernel in `apps/api`. When work is delegated,
the tedi runs in `apps/tedi-runtime`. The embedded widget instead uses that
runtime's conversation path directly. Not every request passes through all
these services: simple Home answers need no delegation or MCP tool call.

## Platform building blocks

- **Workers** provide global request handling and control-plane services.
- **Durable Objects** coordinate long-lived worker identity and stateful
  sessions.
- **D1** stores canonical relational configuration, ledgers, and audit data.
- **R2** stores larger immutable artifacts and published assets.
- **Workflows** run durable multi-step operations with retries.
- **Sandbox containers** provide isolated build or workstation capability when
  a job needs an operating-system process.
- **Cloudflare Artifacts** provides Git-compatible, versioned source storage
  where enabled.

## Separate jobs, separate boundaries

Tedix does not treat every Cloudflare primitive as interchangeable. Public
request handling, durable coordination, Git source, immutable objects, and
container execution have different trust and lifecycle requirements.

This separation lets a worker keep its identity and durable records while an
individual runtime or job environment is replaced.

## Authority boundaries

Tedix classifies source-owned control surfaces into three planes:

- `tenant-product`: identity, runtime, memory, skills, Work Items, policy,
  approvals, rationale, evidence, basic audit/export, and runtime entitlements
- `installation-operations`: installation bootstrap, upgrade, backup, restore,
  health, and installation-owner operations
- `fleet-commercial`: cross-installation administration, global catalog
  curation/promotion, provider and usage settlement, Stripe, and billing
  reconciliation

`apps/api/src/rpc/fleet-authority-guards.json` lists the fleet-commercial API
namespaces and procedures.

The API requires the non-secret `TEDIX_FLEET_AUTHORITY_MODE`. `disabled` makes
fleet-commercial API procedures, Stripe webhooks, and commercial schedules
unavailable before they read commercial tables or provider secrets.
`co-located` explicitly uses the tenant `DB` binding and preserves Tedix Cloud's
current managed deployment. Any other value fails closed. Runtime entitlements
remain on tenant `DB` in every mode.

Not every fleet-commercial table is separate yet. Stripe receipts and
subscriptions, provider reconciliation, and global alert state use the fleet
store. Catalog, submission, template, payment, and remaining billing data still
live in the tenant database, behind the fleet guard.
