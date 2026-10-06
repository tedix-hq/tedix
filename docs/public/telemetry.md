---
sidebar:
  order: 175
title: "Telemetry and network contact"
topic: "Operations"
resource_type: reference
description: "What the Tedix CLI, Workers, widget, and marketing site collect, where it goes, and how to turn it off or point it elsewhere."
summary: "Telemetry disclosure for the tenant product, CLI, and optional marketing-site analytics"
read_when:
  - Evaluating what a Tedix installation sends outside your account
  - Disabling widget or OS analytics
  - Self-hosting Tedix without contacting Tedix Cloud
visibility: public
---

# Telemetry and network contact

The tenant product and CLI send no unsolicited install, usage, or crash reports
to Tedix. Their operational analytics stay in the installation operator's
Cloudflare account. The marketing site (`apps/landing`) separately supports
optional Google Analytics: it loads only in production with a configured
`GA_MEASUREMENT_ID` and the visitor's analytics consent, enforced by
`apps/landing/src/layouts/BaseLayout.astro` and
`apps/landing/src/components/ConsentBanner.astro`.

What self-hosters do need to know is that several **default endpoints point at
Tedix Cloud**. They carry your own requests, not telemetry, but a
self-hosted installation contacts `*.tedix.dev` until you override them. See
[Default endpoints](#default-endpoints-that-point-at-tedix-cloud).

## What is collected, and where it goes

| Source                          | What                                                                | Destination                                 | Default                                                             |
| ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| MCP, runtime, and API Workers   | Request, Code Mode, runtime, and widget counters (Analytics Engine) | Analytics Engine datasets in your account   | On                                                                  |
| All Workers                     | Logs and sampled traces (`observability` in `wrangler.jsonc`)       | Workers Observability in your account       | On; no external destinations configured                             |
| All Workers                     | `logpush: true`                                                     | Only a Logpush job you create               | Inert until you configure a job                                     |
| Tedix OS                        | WebMCP tool-call events (`sendBeacon` to `/webmcp/telemetry`)       | Your own OS origin                          | On                                                                  |
| Embedded widget                 | Reliability metrics for the chat session                            | Your own API, over the session's stream URL | **Off** unless the provider enables widget analytics                |
| CLI                             | Nothing. Wrangler is run with `WRANGLER_SEND_METRICS=false`         | —                                           | —                                                                   |
| Marketing site (`apps/landing`) | Google Analytics page and lead events                               | Google Analytics                            | Off until configured in production and the visitor allows analytics |

## What is never collected

- The tenant product and CLI send no unsolicited usage, install, or crash
  reports to Tedix.
- The tenant product and CLI do not include third-party analytics,
  advertising, or error-reporting services. The optional marketing-site Google
  Analytics described above is separate.
- The CLI has no background update check. It contacts the release server only
  when you run `tedix update`, `tedix update --check`, or `tedix setup`.

## Default endpoints that point at Tedix Cloud

These defaults exist so the CLI and widget work against Tedix Cloud out of the
box. They carry your own requests and credentials to the service you are
using; they are not telemetry. To keep a self-hosted installation off Tedix
infrastructure, override them:

| Component | Default                                                     | Sends                                  | Override                                      |
| --------- | ----------------------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| CLI       | `https://tedix-unified.mcp.tedix.dev/mcp`                   | Your chat turns and bearer token       | `--url` or a saved workspace                  |
| CLI       | `https://api.tedix.dev` (workspace lookup)                  | Your token                             | `TEDIX_API_URL`                               |
| CLI       | `https://os.tedix.dev/cli/login`                            | Browser login                          | `TEDIX_LOGIN_URL`                             |
| CLI       | `https://downloads.tedix.dev` (`tedix update`)              | A plain `GET` for release metadata     | `TEDIX_CLI_BASE_URL`                          |
| CLI       | `https://downloads.tedix.dev` (`tedix setup`)               | A plain `GET` for the release manifest | None yet                                      |
| Widget    | `https://api.tedix.dev/widget/branding/<tenant>`            | Tenant id and locale                   | `data-tedix-api-origin`, or `branding: false` |
| Widget    | `https://mcp-ui.tedix.dev` (MCP app frames)                 | Frame loads for MCP app widgets        | None yet                                      |
| Workers   | `auth.tedix.dev`, `os.tedix.dev`, `mcp.tedix.dev` fallbacks | Auth and link generation               | `DESCOPE_BASE_URL`, `OS_URL`, `MCP_URL` vars  |

A few Worker and auth-package hostnames are still constants with no override.
Self-hosting is experimental; see the
[self-hosted and managed boundary](./self-hosted-boundary.md).

## How to opt out

- **Marketing-site analytics:** reject analytics in the consent banner. To
  disable Google Analytics for a deployment, omit `GA_MEASUREMENT_ID`.
- **Widget analytics:** leave widget analytics disabled for the provider (the
  default), or call `consent({ analytics: false })` from the host page.
- **Analytics Engine and observability:** remove the
  `analytics_engine_datasets` or `observability` blocks from an app's
  `wrangler.jsonc` before you deploy. Test the app afterwards: not every
  writer treats a missing dataset binding as optional.
- **Logpush:** do not create a Logpush job, or delete it.
- **Tedix Cloud endpoints:** set the overrides above to your own hosts.
