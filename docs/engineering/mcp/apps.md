---
summary: "MCP Apps/UI resource contract: widget resource URIs, MIME type, CSP, permissions, host bridge, and host parity"
read_when:
  - Updating MCP Apps resources, widget URI shape, CSP metadata, or host rendering
  - Debugging Tedix OS, ChatGPT Apps-compatible hosts, or generic MCP Apps clients
title: "MCP Apps"
---

# MCP Apps and UI Resources

MCP Apps resources are the portable UI contract. A widget-capable tool must
work in Tedix OS, ChatGPT Apps-compatible hosts (Apps SDK metadata), and generic
MCP Apps clients (`text/html;profile=mcp-app`). Host chrome may differ; URI
shape, MIME type, resource lookup, CSP metadata, and token handling must not.

## Resource Contract

A widget tool and its resource register together; a tool whose widget route
cannot be resolved is skipped.

- `tools/list` carries `_meta.ui.resourceUri` (portable) and
  `_meta["openai/outputTemplate"]` (Apps SDK). Tool `_meta.ui` holds only
  `resourceUri` and `visibility`; `csp`, `permissions`, `domain`, and
  `prefersBorder` live on the resource's `_meta.ui` from `resources/read`.
- `tools/call` returns `structuredContent`. An echoed `_meta.ui.resourceUri` is
  a convenience hosts must not depend on. Code Mode preserves the inner
  `layoutSpec` and `resourceUri` on the outer result.
- URIs are `ui://widgets/mcp-app/{appSlug}/{widgetRoute}.html` for catalog
  widgets and `.../{appSlug}/r/{layoutId}.html` for generated views. They are
  version-agnostic: the `?v=` hash appears only on `openai/outputTemplate`, so
  a host that cached a template across deploys never reads a stale URI.
- `config.mcpAppPermissions` lists the closed permission buckets (`camera`,
  `microphone`, `geolocation`, `clipboardWrite`). Tedix OS delegates only those
  through Permission Policy; browser prompts still decide.
- `register-widget.ts` builds `_meta.ui` by hand so the Worker never loads the
  ext-apps SDK at runtime; `register-widget.test.ts` pins it to
  `@modelcontextprotocol/ext-apps` with a `satisfies` check and a schema
  round-trip.

CSP merges core runtime origins (`MCP_UI_URL`, `MCP_URL`, `API_URL`),
`mcpConfig.widgetCSP`, and per-tool `app_tool_csp_domains`, and is emitted as
both `openai/widgetCSP` and resource `_meta.ui.csp`.

## Generated Views

Generated Code Mode visuals use the same contract with no `app_tools` row:
`ui.create_view()`, `ui.create_health_sweep()`, the validated path
`ui.get_catalog()` → `ui.validate_layout()` → `ui.create_view()`, and
`ui.create_mcp_app()` for free-form HTML/CSS. None persist anything.
`apps/mcp-ui` serves `/r/{layoutId}` (`apps/mcp-ui/src/pages/[app]/r/[layout].astro`).
For a catalog layout, the resource template matches the request's D1 tool
catalog and forwards `layoutSpec` in `X-Tedix-Layout-Spec`. Free-form apps use
a fixed host body; the model's HTML/CSS arrives as bounded data and mounts in a
nested sandbox with scripts disabled. Fragments must use the shell's semantic
CSS variables rather than assume a background. App branding reaches
`apps/mcp-ui` in `X-Tedix-App-Theme` and is injected at render time.

## Tedix OS Host

`WidgetAppFrame` (`apps/os/src/components/widget-frame.tsx`) renders resources
with the ext-apps v2 `AppBridge`:

- prefers `ui://widgets/mcp-app/...` over Apps SDK templates, including inside
  nested Code Mode envelopes;
- passes tool input before result, theme after initialization;
- reports `loading` / `ready` / `unavailable` per mount, isolates renderer
  failures per widget, and falls back to a transcript preview;
- supports inline and fullscreen only; source-checks `ui/open-link` and
  `ui/message` so sibling mounts cannot send each other's messages.

Only app-qualified tool names (`app__tool`) supply app provenance; Code Mode
wrappers are not app identities. A failed layout `call_tool` (including
`isError`) rejects the action and skips state persistence.

### Bridge and tokens

Widget iframes never receive bearer tokens.

- `POST /widgets/mcp` (`apps/os/src/widgets/proxy.ts`) reuses the OS session,
  requires same-origin, allows only Tedix-managed MCP hosts, and forwards a
  fixed method allowlist (`tools/call`, `resources/*`, `prompts/list`,
  `tasks/*`) with a 15 s deadline and 1 MiB limit. `input_required` goes back
  to the widget; task input returns through `tasks/update`.
- `GET /widgets/resource` forwards the verified session JWT with a
  browser-bridge marker over `MCP_SERVICE`. The MCP edge validates it as the
  OAuth user with normal tenant, scope, and tool checks; the bridge never
  upgrades the caller to a service principal, and the marker does nothing on a
  public request.
- `/sandbox_proxy.html` is framed without `allow-same-origin`, so the guest has
  an opaque origin and cannot read OS cookies or DOM. It is the only OS
  response allowed to frame on its own origin; everything else is `DENY`. It
  accepts injection only from its parent at the expected origin.

### View state

`TedixRenderer` persists interaction deltas through `useWidgetViewState`
(`apps/mcp-ui/src/lib/widget-host-hooks.tsx`) after successful actions only.
The envelope does not replace the tool result; without a usable host, state is
document-local. Widgets may call `ui/update-model-context`, but a widget is
never the chat state of record.
