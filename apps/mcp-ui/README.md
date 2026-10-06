# @tedix/mcp-ui

Astro + React Islands renderer for Tedix MCP Apps resources. It serves SSR
HTML for Tedix OS, ChatGPT Apps-compatible hosts, and generic MCP Apps clients.

Default generated widgets use json-render specs from
`app_tools.config.layoutSpec`. Bespoke customer-facing widgets still run through
this app as React Islands backed by `@tedix/widget-ui`; they are not per-app
Workers.

The framework-neutral white-label Tedi widget is independently built and
deployed from `apps/widget` at `widget.tedix.dev`.

Core routes:

- `/` — intentionally empty `404`; the origin is runtime infrastructure, not
  a human-facing product or route directory
- `/health` — deployment provenance readback
- `/{appSlug}/r/{layoutId}` — generated json-render resource
- `/{appSlug}/r/item-detail` — generic detail resource
- `/{appSlug}/r/preview` and `/preview` — preview-only routes

## Version previews

For an operator-owned installation, configure the Worker and its API/MCP
bindings before uploading a version. Set the asset origin explicitly:

```bash
MCP_UI_URL=https://widgets.example.com GIT_SHA=<full-commit-sha> bun run build:production
GIT_SHA=<full-commit-sha> bunx wrangler versions upload \
  --var GIT_SHA:<full-commit-sha> --preview-alias <agent-alias> --strict
```

Run those commands from `apps/mcp-ui`. The upload returns a public preview URL
without promoting it to the installation's active version. Check its `/health`
for the uploaded SHA and `/preview` with a synthetic widget spec. Previews use
the configured API/MCP bindings; do not put customer data in their URLs.
Tedix Cloud releases are handled by the private operations repository.

Key runtime pieces:

- `src/json-render/registry.tsx` — shadcn, Tedix custom components, and standard
  directives
- `src/json-render/TedixRenderer.tsx` — spec/data/state bridge
- `src/lib/widget-host.ts` — shared official MCP Apps guest connection
- `src/lib/widget-host-hooks.tsx` — React bindings and ChatGPT extensions
- `src/components/PreviewRenderer.tsx` — preview-only renderer

Rendering does not use server-side sessions or a session KV binding. Astro
uses an explicit in-memory LRU session driver to avoid adapter-provisioned KV
storage; MCP Apps host state remains owned by the guest connection.

## Architecture

```
apps/mcp-ui/
├── src/
│   ├── pages/
│   │   ├── index.ts                 # Empty 404 route
│   │   └── [app]/
│   │       └── r/
│   │           ├── [layout].astro   # json-render widget route (/r/{layoutId})
│   │           └── preview.astro    # Standalone preview with base64 spec/data
│   ├── components/
│   │   └── PreviewRenderer.tsx      # Preview-only renderer (no host)
│   ├── json-render/
│   │   └── TedixRenderer.tsx        # Universal config-driven renderer
│   ├── layouts/
│   │   └── AppThemeLayout.astro     # CSS variable injection
│   ├── lib/
│   │   ├── widget-host.ts          # MCP Apps guest connection
│   │   └── widget-host-hooks.tsx   # React host bindings
│   └── styles/
│       └── globals.css              # Tailwind + global styles
├── public/
│   └── _headers                     # CORS headers for static assets
├── astro.config.mjs                 # Astro + Vite configuration
└── wrangler.jsonc                   # Cloudflare Workers deployment
```

## Widget Pipeline

Generated widgets use the **json-render** pipeline — config-driven specs stored
in D1 `app_tools.config.layoutSpec`:

1. Tedi configures tool with `widgetKey="render"` and `layoutSpec` in config
2. MCP server passes spec via `X-Tedix-Layout-Spec` header when fetching HTML
3. `[layout].astro` validates + autofixes spec, embeds in `<script>` tag
4. `TedixRenderer` reads spec + MCP Apps tool output and renders via `@json-render/react`

**URL pattern:** `/{appSlug}/r/{layoutId}`

### Spec Validation on SSR

Specs are validated and auto-fixed at SSR time using `@json-render/core`:

- `validateSpec()` checks for structural issues
- `autoFixSpec()` attempts to repair common problems
- Invalid specs that can't be fixed are used as-is (graceful degradation)

## Key Concepts

### React Islands with `client:only="react"`

React components use Astro's `client:only="react"` directive:

- Component does NOT run on server (no SSR hydration issues)
- Only loads and renders on client
- Host hooks execute in the browser only

### MCP Apps Integration

`WidgetWrapper` owns the shared guest connection through `useWidgetConnection`.
`TedixRenderer` reads tool output with `useWidgetToolInfo`, opens links through
`useWidgetOpenExternal`, and dispatches actions with `callHostTool`. Failed tool
actions reject and show an alert. Standalone view state stays local to the widget
document and is not durable across reloads.

Both guests and the OS host use the official ext-apps v2 SDK. Display mode follows
host acknowledgements and notifications; follow-ups use the source-checked
`ui/message` transport. ChatGPT state, modal, and Open in App extensions stay at
the guest edge. Details use the existing local dialog when no host modal exists.

OS can embed completed tool data into resource HTML for hydration. Arrays,
primitives, and null become `{ value: ... }` at the json-render state boundary.
See the public [MCP app platform overview](../../docs/public/mcp-app-platform.md).

## Development

### Prerequisites

- Bun package manager

### Commands

```bash
# From monorepo root
bun run dev              # Start all apps (Vite Task)

# From apps/mcp-ui
bun run dev              # Start Astro dev server on port 3001
bun run generate:catalog-prompt
bun run build            # Build for production
bun run preview          # Preview production build locally
```

## Production Deployment

Deployed to Cloudflare Workers via `@astrojs/cloudflare` adapter.

Set `MCP_UI_URL` to the installation's widget origin before building for
deployment. Local builds default to `http://localhost:3001`.

## Troubleshooting

### Widget blank in ChatGPT

Check browser console for errors. Common issues:

- `/@fs/` paths → Add package to `optimizeDeps.include`
- CORS errors → Verify `corsMiddlewarePlugin()` is first in plugins (dev) or check `public/_headers` (prod)
