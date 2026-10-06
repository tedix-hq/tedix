---
summary: "Index of the engineering reference docs published with the source repository"
read_when:
  - Looking for the engineering docs behind a part of the codebase
  - Choosing between user guides and engineering reference
title: "Engineering docs"
---

# Engineering Docs

User guides live in [docs/public](public/index.md): installation, concepts,
the CLI, the MCP app platform, and licensing. The pages below are the
engineering reference for people changing the code. When a page and the code
disagree, the code wins.

## Start here

- [Architecture](ARCHITECTURE.md): Worker topology, package boundaries, and how
  services talk to each other.
- [Development](DEVELOPMENT.md): local development lanes and how to check a
  change.

## Platform

- [API](platform/api.md): contract-first oRPC and the public REST boundary.
- [Auth](platform/auth.md): identities, credentials, RBAC, and auth middleware.
- [Data model](platform/data-model.md): where state lives and the D1 query
  rules.
- [Database](platform/db.md): Drizzle schema, query modules, and migrations.

## MCP

- [MCP runtime](mcp/runtime.md): the shared MCP Worker and its D1-configured
  apps, tools, and scopes.
- [Code Mode](mcp/codemode.md): sandboxed execution, discovery, and
  result limits.
- [MCP Apps](mcp/apps.md): widget resources, CSP, and the host bridge.

## Workers and cognition

- [Agent runtime](tedi/agent-runtime.md): how a tedi executes and recovers.
- [Cognitive runtime](cognition/runtime.md): sessions, events, streaming, and
  run control.
- [Kernel execution model](cognition/kernel-execution-model.md): dispatch,
  delegation, cancel, and wake-back.
- [Harness](cognition/harness.md): context, tools, rationale, memory, traces,
  and evals around each tedi.
- [Work Items](cognition/work-items.md): records, admission, Attempts, and
  settlement.
- [Skills](cognition/skills.md): storage, lifecycle, executable workflows, and
  MCP exposure.
- [Brain](cognition/brain.md): fact storage, write gates, and retrieval.

## Product surfaces

- [Tedix OS](product/tedix-os.md): the `apps/os` application and its MCP
  projection.
- [Design](product/design.md): design-system rules, tokens, and components.
- [CMS](emdash/cms.md): the Emdash CMS runtime and tenant lifecycle.

## Decisions

- [Minimal gates over pre-proof](decisions/minimal-gates-over-pre-proof.md)
- [Agentic kernel architecture](decisions/agentic-kernel-architecture.md)
- [Agent capability mutation gate](decisions/agent-capability-mutation-gate.md)
- [OT authority](decisions/ot-authority.md)
- [Tedi client OAuth with CIMD](decisions/tedi-client-oauth-cimd.md)
- [Workstations over bodies](decisions/workstations-over-bodies.md)
