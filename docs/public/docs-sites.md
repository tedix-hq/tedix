---
sidebar:
  order: 100
title: "Documentation sites"
topic: "Platform"
resource_type: guide
description: "Create public and organization-only documentation sites from Git with the Tedix CLI."
summary: "Tenant self-service setup for public and private Git-backed Docs sites"
read_when:
  - Creating a documentation site from a Git repository
  - Publishing separate public and private documentation for one organization
visibility: public
---

# Documentation sites

One Tedix organization can operate multiple documentation sites. Each
site chooses its own hostname, Git content root, and delivery policy:

- `accessMode: "public"` serves documentation without a login;
- `accessMode: "organization"` requires membership in the owning organization;
- `sourceAuthMode: "public"` clones a public HTTPS Git repository;
- `sourceAuthMode: "connection"` clones through the organization's governed
  Git provider connection.

Source privacy and reader access are separate choices. A public site may be
built from a private repository, provided its selected content root is safe to
publish.

## Prerequisites

You need only a Tedix workspace login, its Unified MCP gateway, a repository,
and permission to manage MCP applications and content. You do not need the
Tedix source repository or access to the Tedix organization.

Confirm the exact workspace before any mutation:

```bash
tedix -w acme auth status
```

For a private repository, connect the appropriate Git provider in your Tedix
workspace first. The connection remains tenant-scoped; do not paste a personal
access token into a Docs tool call or site record.

## Install Docs into your workspace

Use Code Mode discovery on your selected workspace. Call the returned
`install_tenant_mcp_app` callable with the prepared `tedix-docs` catalog product,
your Unified aggregator slug, a namespace prefix, and your connection provider
when private Git is required. Run a dry run first, then repeat with
`dryRun: false`.

The install result reports whether a one-time connection grant is still
required and returns its normal Tedix connection URL. After installation,
discover the namespace prefix you selected; the examples below use `docs`.

```bash
tedix -w acme code 'async () => await tenant.install_tenant_mcp_app({
  catalogAppSlug: "tedix-docs",
  targetAggregatorSlug: "acme-unified",
  slug: "docs-acme",
  prefix: "docs",
  connectionProviderId: "github",
  connectionScope: "tenant",
  organizationQueryParam: "org",
  toolScopes: ["mcp:content"],
  dryRun: true
})'
```

Review that plan, then repeat it with `dryRun: false`. If your workspace uses a
different aggregator slug or provider ID, use the values returned by discovery
and the workspace connection screen rather than copying these example values.
The installed namespace can take up to 60 seconds to appear on an already-warm
gateway process. Rediscover it before treating the install as failed.

## Create public and private sites

The following one-shot Code Mode call creates both records. Replace the example
repository URL with the exact HTTPS clone URL returned by your Git provider. The
two sites can point to one repository and branch while selecting different
folders:

```bash
tedix -w acme code 'async () => {
  const repositoryUrl = "https://github.com/REPLACE_OWNER/REPLACE_REPOSITORY.git";
  const publicSite = await docs.upsert_docs_site({
    slug: "acme",
    title: "Acme Docs",
    description: "Public product documentation for Acme",
    sourceProvider: "github",
    sourceAuthMode: "connection",
    repositoryUrl,
    branch: "main",
    contentRoot: "docs/public",
    accessMode: "public",
    canonicalUrl: "https://acme.docs.tedix.dev"
  });
  const privateSite = await docs.upsert_docs_site({
    slug: "acme-internal",
    title: "Acme Internal Docs",
    description: "Operating documentation for the Acme organization",
    sourceProvider: "github",
    sourceAuthMode: "connection",
    repositoryUrl,
    branch: "main",
    contentRoot: "docs/private",
    accessMode: "organization",
    canonicalUrl: "https://acme-internal.docs.tedix.dev"
  });
  return { publicSite, privateSite };
}'
```

Keep the two returned site IDs. Start an immutable preview for each site:

```bash
tedix -w acme code 'async () => ({
  publicBuild: await docs.start_docs_build({ siteId: "REPLACE_PUBLIC_SITE_ID" }),
  privateBuild: await docs.start_docs_build({ siteId: "REPLACE_PRIVATE_SITE_ID" })
})'
```

Keep the returned build IDs and poll until both builds report `complete`:

```bash
tedix -w acme code 'async () => ({
  publicBuild: await docs.get_docs_build({ buildId: "REPLACE_PUBLIC_BUILD_ID" }),
  privateBuild: await docs.get_docs_build({ buildId: "REPLACE_PRIVATE_BUILD_ID" })
})'
```

Review the private preview links returned by
`docs.get_docs_preview_link({ buildId })`. Publishing is an explicit mutation;
publish the exact completed builds only after review:

```bash
tedix -w acme code 'async () => ({
  publicRelease: await docs.publish_docs_build({
    siteId: "REPLACE_PUBLIC_SITE_ID",
    buildId: "REPLACE_PUBLIC_BUILD_ID"
  }),
  privateRelease: await docs.publish_docs_build({
    siteId: "REPLACE_PRIVATE_SITE_ID",
    buildId: "REPLACE_PRIVATE_BUILD_ID"
  })
})'
```

Publishing one site does not change the other.

Tedix operates a dedicated release policy for its own public documentation.
Changes to `docs/public` on `main` go live there after the documentation checks
and build pass. If a newer docs change lands during a build, the service waits
for a build of that change. The release history attributes these publishes to
the Docs release service. A manual rollback pauses scheduled publishes
until a maintainer publishes again.

## Validate the tenant boundary

Run the acceptance check from a browser profile that is not signed in to Tedix:

1. The public URL must return documentation without redirecting to login.
2. The organization-only URL must redirect to the Tedix login screen.
3. Signing in as a member of a different Tedix organization must not reveal the
   private content.
4. Signing in as an Acme member must serve the private site with
   `Cache-Control: private, no-store` and an `X-Robots-Tag` that blocks indexing.

An API client can also prove cross-tenant rejection by sending a valid bearer
token from another organization to the private URL; the runtime returns `403`
instead of a login redirect. Never paste that token into a Docs MCP argument.

## Daily package checks

Platform operators can enable a daily version check by setting
`siteVersionCheck: { enabled: true }` in the upgrade project's metadata.
The existing 02:00 UTC platform schedule checks the organization's CMS and
Docs sites. It compares EmDash runtime pins, resolved EmDash and plugin versions
in each theme's `bun.lock`, and the Nimbus image pins with npm's latest releases.
Runtime and image pins come from the API's recorded product source revision;
theme reads record their repository revision. Unavailable reads remain unknown.

The latest report is stored in the project's `siteVersionReport` metadata.
When packages are behind, the check files one proposed Work per site and source
(runtime, theme, or docs image), listing the affected packages and their versions.
For example: “Upgrade the example theme to EmDash 1.5.0”. Later checks reuse the
item for the same target package releases. An optional
`siteVersionCheck.upgradeWorkItems` map links `"<siteId>:<source>"` keys to existing
upgrade Work IDs in the same project. Package-name keys are no longer used.
The check updates those items with its findings. Only platform admins in the
configured organization see one linked alert per site above Sites, combining
its affected sources. The check never builds, upgrades, or publishes a site.

## Safety model and current non-guarantees

Docs builds a locked platform-owned documentation template. It copies documentation
content but never runs the repository's package scripts. The template carries
the Tedix mark and favicon on every site; a per-site logo is not configurable
yet. Private clone
credentials are build-scoped and are not stored in site configuration, build
records, build job parameters, release objects, or output.

A Git push does not automatically build or publish a site. Trigger the build
through the Docs MCP namespace after the desired revision reaches the configured
branch. Direct private-Git sources are read-only today: proposal and commit
tools require an Artifacts-backed source. Custom-domain DNS and hostname setup
may also require an organization administrator until domain self-service is
available through the same gateway.
