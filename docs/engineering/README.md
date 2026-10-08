---
summary: "Index of the engineering reference docs published with the source repository"
read_when:
  - Looking for the engineering docs behind a part of the codebase
  - Choosing between user guides and engineering reference
title: "Engineering docs"
---

# Engineering Docs

User guides live in [docs/public](../public/index.md). These pages hold only
what the code does not show quickly: invariants, cross-component flows, and the
reasons behind them. Rules for a single workspace live in its `AGENTS.md`. When
a page and the code disagree, the code wins; fix or delete the page.

## Start here

- [Architecture](architecture.md): Worker topology, package boundaries, and how
  services talk to each other.
- [Development](development.md): local development lanes and how to check a
  change.

## Platform

- [API](platform/api.md): contract-first oRPC and the public REST boundary.
- [Auth](platform/auth.md): identities, credentials, RBAC, and auth middleware.
- [Data model](platform/data-model.md): where state lives, D1 traps, and
  migration gates.

## MCP

- [MCP runtime](mcp/runtime.md): the shared MCP Worker and its D1-configured
  apps, tools, and scopes.
- [Code Mode](mcp/codemode.md): sandboxed execution, discovery, and
  result limits.
- [MCP Apps](mcp/apps.md): widget resources, CSP, and the host bridge.

## Workers and cognition

- [Agent runtime](tedi/agent-runtime.md): how a tedi executes and recovers.
- [Cognitive runtime](cognition/runtime.md): sessions, events, run control,
  traces, and harness evals.
- [Kernel execution model](cognition/kernel-execution-model.md): dispatch,
  delegation, cancel, and wake-back.
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

Architecture decision records live in [decisions/](../../decisions/README.md).
