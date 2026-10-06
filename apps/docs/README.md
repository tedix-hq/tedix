# @tedix/docs

The Docs control/build Worker also owns semantic retrieval for published public
builds. `publish_docs_build` and `rollback_docs_build` project only the newly
active immutable build's Markdown twins into the `tedix-docs` Cloudflare AI
Search namespace. Organization-protected sites and unpublished previews are
never indexed. The read-only `search_docs` MCP tool filters every result by the
site's current `activeBuildId` and exact source revision, and returns cited
canonical URLs. The documentation site's Pagefind remains the browser-local exact-search path.

Multitenant documentation publishing for Git-backed Markdown and MDX sites.

## Overview

`apps/docs` builds tenant documentation with a pinned
`@cloudflare/nimbus-docs` renderer. A Cloudflare Workflow checks out source in
an isolated Sandbox container and stages a static Astro build under an
immutable R2 prefix. Builds are private previews by default. A separate
admin-scoped release action atomically switches the site's active build in D1.
The request plane is a least-privilege Worker in `apps/docs-runtime`; tenant
MDX never executes on a live request.

The builder currently pairs `@cloudflare/create-nimbus-docs@0.7.7` with
`@cloudflare/nimbus-docs@0.15.0`. Keep both versions explicit in the Dockerfile
and verify a complete image and tenant-content build when either changes. The
copied templates use Nimbus's built-in icon component. Its shared Markdown
route does not repair source-relative links, so Tedix retains its custom
Markdown route until that behavior exists upstream. Tenant workspaces symlink
the image's pinned dependencies; the template keeps Vite symlink paths intact
so Astro 7 and Rolldown share compiled-module cache keys.

Run `bun run --cwd apps/docs test:nimbus-image` for the pinned image contract:
real Astro diagnostics and build, root-route ownership, Markdown link repair,
Pagefind exclusion, and sitemap provenance plus `noindex` exclusion.

## Source Support

- Cloudflare Artifacts repositories using short-lived, read-only Git tokens.
- Public GitHub and GitLab HTTPS repositories.
- Private GitHub and GitLab HTTPS repositories through a governed tenant
  connection.
- Public HTTPS Git repositories hosted elsewhere.
- Import of a public external repository into Cloudflare Artifacts.

Private GitHub or GitLab credentials are deliberately not stored in
`docs_sites`. Unified resolves the tenant connection and Docs passes the
credential only through the build-scoped Sandbox filesystem for checkout. Raw
tokens do not enter MCP arguments, Workflow state, D1, R2, or build logs.
Direct private-Git builds are read-only; Git proposal and commit operations
still require an Artifacts-backed source.

## MCP

The direct Streamable HTTP endpoint is `POST /mcp?org=<slug>`. Each organization
can install the prepared Docs catalog product into its Unified MCP gateway and
choose the resulting namespace prefix.

The surface covers site/source configuration, Git file reads, review-branch
proposals and diffs, private preview builds, fast-forward commits, publication,
rollback, and release history. Read operations require `mcp:content.read`;
proposals and previews require `mcp:content.write`; source changes, commits,
publish, and rollback require `mcp:content.admin`.

Tenant authorization uses the same Descope organization membership model as
the CMS. Unified uses a Worker service binding and forwards trusted actor
evidence so builds, changes, and releases retain the real external-agent, tedi,
user, M2M, or service principal. `PLATFORM_SERVICE_TOKEN` is accepted only for
platform service operations.

## Development

```bash
bun run test
bun run type-check       # generates binding types with cf, then tsc --noEmit
bun run build            # vp build; also builds the Sandbox container image
```

`cloudflare.config.ts` is the Worker configuration. Building and deploying
need Docker. Three rules fail without an error at review time:

- The container `name` is the live application's name. `cf` finds the
  application by name, so a changed name creates a second application.
- `exports.DocsBuildSandbox` keeps `storage: "sqlite"` and its class name. A
  deleted or renamed export drops every build sandbox.
- Every live Worker secret is a `bindings.secret()`. `cf deploy` deletes any
  secret the config does not declare.

This repository does not yet provide an isolated local data-plane profile for
this Worker. Do not run its `dev` script from a source checkout;
use the source-only checks above and the
[self-hosted boundary](../../docs/public/self-hosted-boundary.md).

The Worker/control-plane split follows the public
[Cloudflare architecture](../../docs/public/cloudflare-architecture.md).
