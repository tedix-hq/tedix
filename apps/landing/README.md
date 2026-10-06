# @tedix/landing

Public landing page for Tedix. Built with Astro 7 on Cloudflare Workers.

This Worker serves the marketing pages and public app directory at `tedix.dev`.

## Overview

Marketing site at `tedix.dev` showcasing the platform plus a public AI app
directory. Pages are server-rendered on Cloudflare Workers and federate live
data from `apps/api` via `@tedix/api-client` (no direct DB access).

**Features:**

- SSR marketing, legal, and product pages with fast edge delivery
- Public AI app directory (`/apps`, `/apps/[slug]`, `/apps/insights`)
- Programmatic SEO surfaces: dynamic sitemaps, `robots.txt`, `llms.txt`,
  IndexNow, and the canonical A2A `/.well-known/agent-card.json`
- i18n routing (`en`, `de`, `es`)

## Development

```bash
# Install dependencies
bun install

# Start dev server (port 3003)
bun run dev

# Build for production
bun run build

# Type-check (astro sync + tsc)
bun run type-check
```

## Architecture

```
apps/landing/
├── src/
│   ├── pages/           # Astro routes (SSR) + API/SEO endpoints (*.ts)
│   ├── components/      # Astro/React island components
│   ├── layouts/         # Page layouts
│   ├── lib/             # API client wiring (@tedix/api-client)
│   └── styles/          # Global styles (Tailwind v4)
├── public/              # Static assets
├── astro.config.mjs     # Astro configuration
└── wrangler.jsonc       # Cloudflare Workers config
```

The app directory reads from `apps/api` (federation over ingestion); catalog
endpoints under `src/pages/api/catalog/` proxy live API data for SSR pages.

## Stack

- **Framework:** Astro 7 (SSR, `output: "server"`)
- **Adapter:** `@astrojs/cloudflare` 14
- **Islands:** `@astrojs/react` / React
- **CSS:** Tailwind CSS v4 via `@tailwindcss/vite`
- **UI:** app-local Kumo adapters in `src/components/ui/` + `@tedix/widget-ui`

## Environment

| Variable                 | Description                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `ENVIRONMENT`            | `development` / `production`                                                        |
| `LANDING_INSPECTOR_PORT` | Cloudflare adapter inspector port; set `0` in CI/type-check to avoid port conflicts |

## URLs

- **Production:** https://tedix.dev
- **Local:** http://localhost:3003

Production deployment is maintained separately from local development. See the
[release status](../../docs/public/release-status.md) for supported deployment options.
