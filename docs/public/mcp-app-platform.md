---
sidebar:
  order: 50
title: "MCP app platform"
topic: "Platform"
resource_type: guide
description: "Connect digital workers to tools and applications through MCP."
summary: "Public overview of the Tedix MCP application platform"
read_when:
  - Connecting tools to Tedix
  - Understanding tenant-scoped MCP applications
visibility: public
---

# MCP app platform

Tedix uses the Model Context Protocol (MCP) as a standard way to connect
workers and compatible clients to tools, prompts, resources, and interactive
application components.

## Tenant-scoped connections

A shared application definition can be connected separately for each
organization. Credentials and policy remain tenant-scoped, so installing the
same integration for two customers does not mix their data or authority.

## Configured at runtime

Tedix applications are configured from durable metadata. Tool schemas,
required scopes, identity rules, and UI resources can evolve without creating
a separate Worker deployment for every tenant.

## MCP and durable work

MCP calls can participate in durable Tedix work:

- tools are attributed to the worker and run that used them;
- long-running operations can return durable task identifiers;
- policies can require confirmation before sensitive mutations;
- results can be attached to rationale and audit records.

MCP provides the connection surface. Tedix adds tenant identity, governance,
durability, and audit records around that surface.

## Trace one tool

One external-transport test starts with this configuration:

```json
{
	"transport": "external",
	"method": "GET",
	"baseUrl": "https://api.example.test",
	"endpoint": ""
}
```

Run it from a source checkout:

```sh
bun run --cwd apps/mcp test:run src/mcp/handler-external.test.ts -t 'allows OpenAPI root path'
```

The test mocks the upstream response and verifies `{ "ok": true }`. It needs
no provider account and does not install a live integration. Follow
the test (`apps/mcp/src/mcp/handler-external.test.ts`) into `ToolHandler`
(`apps/mcp/src/mcp/handler.ts`) to see execution, then the tool schema
(`packages/db/src/schema/tools.ts`) for persisted configuration. Live tools also require tenant-owned connection
credentials and an explicit scope decision; see the
MCP agent guide in the source tree (`apps/mcp/AGENTS.md`).

## Optional Interaction reply events

An MCP app can opt into `work.interaction.responded` using
`mcpConfig.interactionEvents: true`. This adds MCP 2.0 event discovery and
webhook subscriptions on the authenticated MCP endpoint. Each subscription
requires an exact organization and Interaction request ID, human OAuth access,
and a verified public HTTPS callback. Notifications contain saved record IDs;
the host retrieves the answer through the existing read tool.

Delivery uses signed callbacks, duplicate suppression and bounded retries. Access is rechecked before delivery.
Subscriptions expire no later than the credential; the host must refresh them.
Notifications are not replayed, and a saved answer is not guaranteed to produce
one. If you miss a notification, read the request; a successful callback
acknowledges receipt, not task completion.

OpenAI currently supports these events in ChatGPT Work on web, desktop Work with
Cloud selected, and dots. Local Codex desktop wake-up is not proved by this
integration. Local context hooks remain optional and require host trust; native
Codex Goals own continuation of executable work. See [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events).

## Configured native catalog tools

An app can configure tools with `transport: "catalog"` and the closed
`catalog/search` or `catalog/describe` endpoint. Search accepts query, namespace,
bounded paging, and schema inclusion options; describe accepts an exact
`namespace.tool` callable. These operations use the same request-local discovery
projection as Code Mode without creating a Dynamic Worker. Discovery reports
execution authorization; it does not grant it.

Each enabled row needs its own explicit capability mapping. Missing, empty,
invalid, namespace-only or wildcard-only mappings do not expose the tool.
The compact gateway lists the base tools plus its actually configured,
caller-permitted catalog rows using the stored tool metadata and stable paging.
No configured rows means the base surface stays unchanged. Aggregate-only rows
are available after normal session construction, not through compact list
hydration. The stateless lane still omits `ask`.

Catalog operations execute synchronously in the original caller context;
async-task replay and executable code inputs are refused. Arbitrary Code Mode
programs still use a fresh anonymous isolated Dynamic Worker with no ambient
network access. Native catalog calls can still use the existing discovery API
and ranking services.

Configured catalog rows use the shared strict search or describe input declaration.
They require capability-map mode (`enforcePolicies: false`); policy-mode rows do not expose this transport.
