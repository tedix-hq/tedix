# @tedix/docs-runtime

Read-only serving edge for public and organization-protected Tedix documentation sites.

## Overview

The runtime resolves `docs.tedix.dev`, configured exact host aliases, or
`{slug}.docs.tedix.dev` through the shared
`@tedix/db/queries/docs-sites/sites` query leaf, then streams the active build's
immutable object from R2. Public sites retain shared-cache headers.
Organization-protected sites validate the shared Descope browser session
against the owning organization's tenant ID before streaming bytes, then use
private, no-store responses. The runtime does not receive provider credentials,
Cloudflare Artifacts access, Workflows, containers, or management secrets.
Markdown and MDX execute only in the separate `apps/docs` build plane.

## Routes

- `docs.tedix.dev/*` serves the platform site configured by
  `DOCS_ROOT_SITE_SLUG`.
- Exact host aliases configured in `DOCS_HOST_ALIASES` serve their mapped sites;
  the resolved site's access policy determines whether organization membership
  is required.
- `{slug}.docs.tedix.dev/*` serves a tenant documentation site.
- Protected sites redirect anonymous browsers to the Tedix login with the
  owning organization selected and reject bearer tokens for another tenant.
- `/health` returns runtime liveness and the deployed Git SHA.

The runtime follows the public
[Cloudflare architecture](../../docs/public/cloudflare-architecture.md); its
exact control/runtime contract is expressed by this package's source and
bindings.
