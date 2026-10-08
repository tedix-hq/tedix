---
summary: "MCP Apps/UI resource contract: widget resource URIs, MIME type, CSP, permissions, host bridge, and host parity"
read_when:
  - Updating MCP Apps resources, widget URI shape, CSP metadata, or host rendering
  - Debugging Tedix OS, ChatGPT Apps-compatible hosts, or generic MCP Apps clients
title: "MCP Apps"
---

# MCP Apps and UI Resources

This page owns how Tedix MCP tools expose interactive HTML resources and how
hosts render them. MCP Apps resources are the portable UI contract: Tedix OS is
the primary host, but nothing about the contract is Tedix OS-specific.

A widget-capable tool must work in:

- Tedix OS chat and canvas hosts;
- ChatGPT Apps-compatible hosts that read Apps SDK metadata;
- generic MCP Apps clients that read `text/html;profile=mcp-app` resources.

Host chrome may differ. URI shape, MIME type, resource lookup, CSP metadata,
and token handling must not.

## Resource Contract

Widget-capable tools register the tool and its resource together; a tool whose
widget route cannot be resolved is skipped.

- `tools/list` includes annotations, `_meta.ui.resourceUri` (the portable link
  to the resource), and `_meta["openai/outputTemplate"]` for Apps SDK hosts.
- `tools/call` returns `structuredContent` when typed data exists. Results may
  echo `_meta.ui.resourceUri` as a convenience; hosts must not depend on it.
- Code Mode preserves the inner result's `layoutSpec` and
  `_meta.ui.resourceUri` on the outer `code` result.

Resource URIs:

```text
# Catalog widget tools (register-widget.ts)
ui://widgets/mcp-app/{appSlug}/{widgetRoute}.html

# Generated Code Mode views (no app_tools row)
ui://widgets/mcp-app/{appSlug}/r/{layoutId}.html
```

URIs are version-agnostic. The `?v=` cache-busting hash appears only on
`openai/outputTemplate`, so a host that cached a template across deploys never
reads a stale resource URI.

MIME type for MCP Apps hosts: `text/html;profile=mcp-app`. ChatGPT-compatible
hosts use `openai/outputTemplate`, `openai/widgetCSP`, and
`text/html+skybridge`, derived from the same tool config, route, CSP, and
branding.

Tool `_meta.ui` carries only `resourceUri` and `visibility`
(`["model", "app"]`). Rendering and security policy — `csp`, `permissions`,
`domain`, `prefersBorder` — lives on the resource's `_meta.ui`, returned by
`resources/read`.

### Permissions

A tool's `config.mcpAppPermissions` lists the closed MCP Apps permission
buckets (`camera`, `microphone`, `geolocation`, `clipboardWrite`), each with
`{}` as its value. Missing or malformed config emits `{}`. Tedix OS advertises
only those grants in `ui/initialize` and delegates them to the guest iframe
through Permission Policy. Browser and OS prompts still decide; metadata cannot
bypass user consent.

### Parity with the SDK

`register-widget.ts` builds `_meta.ui` by hand so the Worker does not load the
MCP Apps SDK at runtime. `register-widget.test.ts` pins the output to
`@modelcontextprotocol/ext-apps` with both a `satisfies` type check and a
runtime schema round-trip:

- `WIDGET_MIME_TYPES.MCP_APP` equals the SDK `RESOURCE_MIME_TYPE`;
- `buildToolMeta().ui` satisfies `McpUiToolMeta`;
- `buildMcpAppResourceMeta().ui` satisfies `McpUiResourceMeta` (camelCase CSP
  buckets `connectDomains`, `resourceDomains`, `frameDomains`,
  `baseUriDomains`, plus `permissions`, `domain`, `prefersBorder`).

## Generated Views

Generated Code Mode visuals use the same contract without an `app_tools` row.
`apps/mcp-ui` serves the `/r/{layoutId}` resource with
`text/html;profile=mcp-app` and resource `_meta.ui.csp`. Generic hosts can call
`resources/read` directly on the app's MCP server.

For a catalog layout served through Code Mode, the resource template matches
the app and `/r/{layoutId}` against the request's D1 tool catalog and forwards
`app_tools.config.layoutSpec` to the widget Worker in `X-Tedix-Layout-Spec`.
Nothing is persisted by this lookup.

| Path                    | Entry point                                                      | Persistence | Use                                                             |
| ----------------------- | ---------------------------------------------------------------- | ----------- | --------------------------------------------------------------- |
| One-turn visual         | `ui.create_view()`                                               | none        | Table, chart, comparison, timeline, stats, or summary           |
| Health sweep            | `ui.create_health_sweep()`                                       | none        | Compact multi-provider status                                   |
| Validated custom layout | `ui.get_catalog()` → `ui.validate_layout()` → `ui.create_view()` | none        | Model builds a json-render spec against exact component schemas |
| Free-form MCP App       | `ui.create_mcp_app()`                                            | none        | Bounded HTML/CSS in a nested, script-free sandbox               |

The free-form URI is `ui://widgets/mcp-app/{appSlug}/r/generated-app.html`. Its
body is a fixed host; the model's HTML/CSS arrives as bounded tool-result data
and mounts in a second sandbox with scripts and external capabilities disabled.

Hosts pass light/dark mode through MCP Apps host context. Generated fragments
must use the shell's semantic surface/text/border CSS variables rather than
assuming a background color.

## Hosts

### Tedix OS

Tedix OS renders resources with the ext-apps v2 `AppBridge` through the
OS-owned `WidgetAppFrame` (`apps/os/src/components/widget-frame.tsx`) and
`PostMessageTransport`. The host:

- detects widget-capable results, including nested Code Mode envelopes, and
  prefers `ui://widgets/mcp-app/...` resources over Apps SDK templates;
- fetches HTML through `GET /widgets/resource` and proxies guest MCP calls
  through `POST /widgets/mcp`;
- passes `toolInput`, `toolResult`, `layoutSpec`, the resource URI, app
  identity, and host context (input before result; theme after initialization);
- reports each mount as `loading`, `ready`, or `unavailable`, isolates renderer
  failures per widget, and falls back to a native transcript preview;
- supports inline and fullscreen (`ui/request-display-mode`); PiP is not
  advertised, and unsupported modes return the current mode;
- handles external links through `ui/open-link` and follow-ups through
  `ui/message`, source-checked so sibling mounts cannot send each other's
  messages.

Only app-qualified tool names (`app__tool`) supply app provenance; Code Mode
wrappers are not app identities. Layout `call_tool` failures (including
`isError` results) reject the action, show a dismissible alert, and skip state
persistence. Proxy failures keep their JSON-RPC codes; HTTP timeout is 504.

Guests use `@modelcontextprotocol/ext-apps` v2 through
`apps/mcp-ui/src/lib/widget-host.ts`, one SDK connection per widget document.
ChatGPT-specific state and modal methods stay at the guest edge; portable calls
use MCP Apps.

A real Chromium host/guest test exercises the production frame and sandbox
proxy:

```bash
bunx playwright install chromium
bun --cwd apps/os run test:browser:apps
```

### Generic MCP Apps hosts

Read `_meta.ui.resourceUri`, call `resources/read`, sandbox the returned HTML,
apply resource `_meta.ui.csp`, pass tool input/output and host context, and
degrade missing optional callbacks without rendering an empty UI.

### ChatGPT Apps-compatible hosts

Consume `openai/outputTemplate`, honor `openai/widgetCSP`, and may use Apps
SDK state metadata.

## Host Bridge and Tokens

Widget iframes never receive bearer tokens.

`POST /widgets/mcp` (`apps/os/src/widgets/proxy.ts`) reuses the Tedix OS
session, requires same-origin requests, allows only Tedix-managed MCP hosts, and
forwards only `tools/call`, `resources/list`, `resources/templates/list`,
`resources/read`, `prompts/list`, `tasks/get`, `tasks/update`, and
`tasks/cancel`. It uses the modern stateless protocol when `server/discover`
advertises it and falls back to an initialize/session flow otherwise. Upstream
calls have a 15-second deadline and a 1 MiB response limit. `input_required` is
returned to the widget; task input goes back through `tasks/update`.

`GET /widgets/resource` verifies the browser session and tenant, then forwards
the same signed JWT with a browser-bridge marker over the private
`MCP_SERVICE` binding. The MCP edge validates the JWT as the OAuth user and
applies normal tenant, scope, policy, and tool checks. The bridge never
upgrades the caller to a service principal, and the marker has no effect on a
public request.

## CSP

Widget CSP merges:

1. core runtime origins from environment (`MCP_UI_URL`, `MCP_URL`, `API_URL`,
   WebSocket origins);
2. `apps.metadata.mcpConfig.widgetCSP`;
3. per-tool `app_tool_csp_domains`.

The merged policy is emitted as both `openai/widgetCSP` and resource
`_meta.ui.csp`.

## Sandbox Proxy

```text
host → sandbox proxy iframe → guest widget HTML
```

`/sandbox_proxy.html` (`apps/os/public/sandbox_proxy.html`) is framed without
`allow-same-origin`, so the guest has an opaque origin and cannot read Tedix OS
cookies or DOM. It is the only OS response allowed to frame on its own origin
(`X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`); every other response
is `DENY`. It accepts injection only from its parent at the expected origin:
it sends `ui/notifications/sandbox-proxy-ready`, receives
`ui/notifications/sandbox-resource-ready` with `{ html }`, and injects the
document.

## Theming

`apps/mcp` passes app branding to `apps/mcp-ui` in `X-Tedix-App-Theme`. The
widget server injects CSS variables at render time to avoid a flash of
unstyled content. Host chrome stays host-owned.

## View State

```text
json-render StateStore → TedixRenderer → useWidgetViewState → WidgetHost → host
```

`TedixRenderer` persists interaction deltas through `useWidgetViewState`
(`apps/mcp-ui/src/lib/widget-host-hooks.tsx`). The envelope holds the widget
identity and `interactionState`; it does not replace the tool result.
Successful actions trigger persistence; hydration and failed actions do not.
Equal snapshots are not guaranteed to be deduplicated. Without a usable host,
view state is local to the document and lost on reload.

Widgets may call `ui/update-model-context`, but a widget is never the chat
state of record. Widgets consume completed tool results and ask the host for
follow-up calls.

## Release Checklist

1. `tools/list` advertises annotations, Apps SDK metadata, and a matching resource.
2. `tools/call` returns `structuredContent` (and `_meta.ui.resourceUri` where applicable).
3. `resources/read` returns `text/html;profile=mcp-app` for the same URI.
4. CSP is present in both Apps SDK and MCP Apps metadata.
5. Tedix OS renders one inline visual without duplicate raw JSON cards.
6. A generic MCP Apps client can read and sandbox the resource without Tedix OS.
7. Guest MCP calls go through a host bridge, never iframe tokens.
8. Resource URIs are stable across deploys.
9. Broken or missing resources degrade to structured previews, not blank loaders.
10. A renderer failure affects only its own mount.

## Source Map

| Area                       | Files                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| Tool/resource registration | `apps/mcp/src/mcp/tool-registration.ts`, `apps/mcp/src/mcp/utils/register-widget.ts`                      |
| SDK parity test            | `apps/mcp/src/mcp/utils/register-widget.test.ts`                                                          |
| Generated Code Mode UI     | `apps/mcp/src/mcp/codemode.ts`                                                                            |
| Resource serving           | `apps/mcp-ui/src/pages/[app]/r/[layout].astro`                                                            |
| Renderers                  | `apps/mcp-ui/src/json-render/TedixRenderer.tsx`, `apps/mcp-ui/src/components/GeneratedMcpAppRenderer.tsx` |
| Tedix OS host bridge       | `apps/os/src/components/widget-frame.tsx`, `apps/os/src/widgets/proxy.ts`                                 |

## Related

- [MCP runtime](runtime.md)
- [Code Mode](codemode.md) — `ui.*` helpers
- [Auth](../platform/auth.md)
- [Design](../product/design.md)
