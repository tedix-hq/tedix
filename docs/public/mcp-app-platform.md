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

To connect your own assistant to Tedix, see
[Use Tedix in ChatGPT, Codex and Claude](./learning-paths/first-plugin.md).
This page is about connecting tools and applications to Tedix workers.

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
`mcpConfig.interactionEvents: true`. This adds MCP 2.0 event discovery,
polling and webhook subscriptions on the authenticated MCP endpoint. Polling
uses a messaging read scope (`mcp:messaging.read`) and optional `request_id`,
`work_item_id` and `responder_type` filters. Each webhook subscription
requires an exact organization and Interaction request ID, human OAuth access,
and a verified public HTTPS callback. Notifications contain saved record IDs;
the host retrieves the answer through the existing read tool.

Delivery uses signed callbacks, duplicate suppression and bounded retries. Access is rechecked before delivery.
Subscriptions expire no later than the credential; the host must refresh them.
Webhook notifications are not replayed, and a saved answer is not guaranteed
to produce one. If you miss a notification, read the request; a successful
callback acknowledges receipt, not task completion.

OpenAI currently supports these events in ChatGPT Work on web, desktop Work with
Cloud selected, and dots. Local Codex desktop wake-up is not proved by this
integration. Local context hooks remain optional and require host trust; native
Codex Goals own continuation of executable work. See [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events).

### Poll Work and skill-run events

The same flag also adds five ledger events to `events/list`:
`work.item.state_changed` (accepted, completed, cancelled, Attempt settled),
`work.approval.requested`, `work.item.commented`,
`work.interaction.requested` and `skill.run.failed`. Each poll needs human OAuth
that selects `organization_id`, plus a Work read scope (`mcp:work.*`) or, for
skill runs, a skills scope. Reads come from the organization's own ledgers, so
an agent never sees another organization's events. Payloads carry IDs and
enums only. Comment events omit bodies and metadata; Interaction request
events omit subjects, prompts and metadata. Filter comments by `work_item_id`
and `author_type`, or requests by `work_item_id`, `target_id` and `kind`.
Reply events (`work.interaction.responded`) can also be polled with a messaging
read scope (`mcp:messaging.read`), filtered by `request_id`, `work_item_id` and
`responder_type` (`user`, `tedi` or `external_agent`). Reply payloads contain
only organization, request and response IDs. Re-read the record before acting.

```sh
curl -s https://<app-host>/mcp -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: events/poll" -d '{"jsonrpc":"2.0","id":1,"method":"events/poll",
  "params":{"name":"work.item.state_changed","cursor":null,
  "arguments":{"organization_id":"00000000-0000-4000-8000-000000000001"}}}'
```

A `null` cursor starts from now and returns a fresh `cursor`. Store it and pass
it on the next poll. Poll again at once while `hasMore` is true, otherwise
after `nextPollMs`. Neither Claude Code nor the Codex CLI polls MCP events
for a custom server today; `tedix channel` (below) polls for either. Without
the webhook opt-in below, `events/subscribe` answers `-32026` for these
five events; reply webhooks still require an exact request. Discovery lists the
extension as `io.modelcontextprotocol/events` under `capabilities.extensions`.

### Deliver events into a Claude Code or Codex session

Claude Code starts a turn on a channel message from a local stdio MCP server,
not on an event from a remote server. `tedix channel claude` is that server: it
polls these events with your stored login and sends each one to the session
as a short ID-only notice. Register it in `.mcp.json`:

```json
{
	"mcpServers": {
		"tedix-events": {
			"command": "tedix",
			"args": ["-w", "connect", "--organization", "<slug>", "channel", "claude"]
		}
	}
}
```

Start an interactive session with
`claude --dangerously-load-development-channels server:tedix-events`; channels
are a Claude Code research preview and do not load with `claude -p`. Name
events after `claude` to limit them, and add `--param work_item_id=<uuid>` (or
another `inputSchema` key) to filter.

The Codex CLI has no inbound path for a local thread.
`tedix channel codex <thread-id>` runs until interrupted and sends each batch
of events to that thread through `codex queue`; when no Codex window takes it,
the thread resumes headless with `codex exec resume` in the current directory.
The same filters apply. ChatGPT Work receives these events by webhook instead
(below).

### Subscribe to Work and skill-run events by webhook

Set `mcpConfig.eventWebhooks: true` next to `interactionEvents` to let hosts
subscribe to the same five events instead of polling. `events/list` then
shows `"delivery": ["poll", "webhook"]` for them. A subscription needs the
same human OAuth grant and read scope as a poll, a public HTTPS callback that
echoes the verification `challenge`, and a `whsec_` secret of 24 to 64 bytes:

```sh
curl -s https://<app-host>/mcp -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: events/subscribe" -d '{"jsonrpc":"2.0","id":1,
  "method":"events/subscribe","params":{"name":"work.item.state_changed",
  "arguments":{"organization_id":"00000000-0000-4000-8000-000000000001"},
  "delivery":{"mode":"webhook","url":"https://hooks.example.com/tedix",
  "secret":"whsec_<base64 of 32 random bytes>"},"ttlMs":3600000}}'
```

The result carries `id`, `cursor` and `refreshBefore`. The lease lasts at most
24 hours and never outlives the bearer. Send the same request with a fresh
token before `refreshBefore` to renew it; renewal keeps the delivered
position. Pass a `cursor` from `events/poll` to resume from it. Send
`events/unsubscribe` with the same `name`, `arguments` and `delivery.url` to
stop.

Tedix checks for new events every two minutes. Before each pass it rechecks
the token, consent, selected organization, read scope and the app opt-in;
access that has ended stops delivery. Each event is a POST signed like the
Interaction reply event (`webhook-id`, `webhook-timestamp`,
`webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>`). The body is
`{eventId, name, timestamp, data, cursor}`.

Delivery is at least once, so deduplicate on `webhook-id`. A failed page is
retried with backoff from two to 30 minutes. After six failures in a row, or a
`410`, the subscription is marked unhealthy and delivery stops. Events from
that period are dropped; subscribe again to restart from now. Each
subscription receives at most 300 events per hour, and later events wait for
the next hour. A caller can hold 20 subscriptions per organization.

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
