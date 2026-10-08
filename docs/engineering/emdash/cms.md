---
summary: "Emdash CMS runtime, tenant lifecycle, content operations, deploy workflow, and what proves a capability is active"
read_when:
  - Learning how Emdash concepts map to Tedix CMS agent operations
  - Adding, archiving, restoring, or removing a CMS site
  - Updating the CMS runtime, starters, or Site Builder content operations
  - Debugging tenant content behavior or CMS capability state
title: "Emdash CMS"
---

# Emdash CMS

Emdash is the tenant CMS runtime behind Tedix content sites. The parent Worker
(`apps/cms-runtime`) resolves the tenant, loads the active bundle from R2, and
injects the tenant's database, media, session, auth, branding, and routing into
that bundle through Worker Loader. `apps/cms` (Site Builder) owns the `cms_*`
MCP tools, the preview sandbox, and the build/deploy workflow. Scoped rules for
Site Builder are in `apps/cms/AGENTS.md`; the user guide is
[Websites and CMS](../../public/cms.md).

## Runtime invariants

- **Active bundle** is `tenant_bundles WHERE slug = ? AND is_active = 1`. A
  deploy uploads `{slug}/v{N}/` to R2, then flips the active row. Bundles are
  immutable, and each records one source identity: the full Artifacts commit
  (`sourceCommit`) or the SHA-256 digest of the editable source set. Older rows
  may have `sourceRevision: null`; never infer one.
- **Durable Object SQLite is the tenant database.** Starters use the
  Worker-Loader-safe `durableObjects({ binding: "DB_DO", name:
process.env.ORG_SLUG, session: "auto" })` descriptor; the parent declares
  `EmDashDB` and injects `DB_DO` as a serializable RPC stub. Activation checks
  the compiled adapter; rollback refuses a bundle built for another adapter.
  Postgres/Hyperdrive is unsupported: it lacks cron, scheduled publishing,
  plugin cron, media providers, and sandboxed plugins.
- **Native bindings stay in the parent.** Worker Loader isolates cannot receive
  native R2, KV, Images, or AI Search bindings, so the parent serves `/_image`
  itself and injects narrow RPC facades (for example `TenantR2`, and a
  tenant-pinned AI Search facade that exposes one derived private instance).
- **Isolate cache key** (`apps/cms-runtime/src/tenant-cache-key.ts`) covers the
  bundle, manifest, tenant metadata, and fingerprints of injected values, so
  rotating an injected value evicts loaded isolates.
- **No global in-flight promise caches** in runtime or theme helpers; a
  cancelled request must not leave a shared promise pending. Shared parent
  response caching stays off; tenant HTML is `private, no-store`.
- **Plugin secret settings** are encrypted with a per-site key derived from
  `EMDASH_ENCRYPTION_KEY` and the immutable site ID
  (`apps/cms-runtime/src/tenant-emdash-encryption.ts`); only the derived key
  reaches the isolate. Rotate by storing `new,old`, re-saving secret settings,
  then dropping the old key. Losing the master key loses those settings.
- **Lead-form IPs** are replaced by a tenant-scoped HMAC pseudonym under
  `LEAD_FORM_IP_HASH_HMAC_KEY`; plugins never see the key, and submit fails
  closed without it.
- **Scheduling** belongs to the parent cron: `apps/cms-runtime` loads each
  active bundle and calls its Emdash `scheduled()` handler. The starter's
  `src/worker.ts` exports and `wrangler.jsonc` cron must stay in the snapshot.

## Agent model

Each site is code that renders content. The theme is a full Astro project
(editable tenant source plus locked platform files, restored at deploy from
`apps/cms/src/template-snapshot.ts`); content lives in the site's EmDashDB
object and media bucket and is never touched by a bundle deploy. Starters are
selected by strict `templateSlug`
(`packages/api-contract/src/schemas/cms-template.ts`). A seed change never
migrates an existing site.

1. Read first: `get_site_overview` returns settings, runtime health, active
   bundle version, source revision, and hot CSS revision.
2. Editorial changes: draft, preview, publish, then verify the public route.
   Restoring a revision creates a draft.
3. Small CSS changes use the hot theme (`/_tedix/theme.css`,
   `rollback_hot_theme`). Markup or behavior changes edit source, preview, and
   `theme_deploy({ sourceCommit })`; roll back with `theme_rollback`.
4. Platform changes edit the shared starter, regenerate the snapshot, deploy
   Site Builder, then `template_propagate`. A starter edit alone never updates
   active bundles, and a Studio deploy never adds routes to compiled bundles.

A source commit does not prove its bundle is active, and a successful build
does not prove the public route: read both back after every deploy. For a
bundle identified only by a digest, call `theme_workspace_status` and seed
Artifacts from the Builder workspace only if its digest matches the active
bundle; on drift, do not reset the sandbox or deploy a replacement.

Content-tool traps: `content_create` always makes a draft and sends the whole
payload in one request; before retrying an ambiguous create, query slug and
locale and reuse an exact match. `supports: ["search"]` does not activate the
index; call `configure_search({ collection, enabled: true })`. The visitor
WebMCP `search_site` (`apps/cms-runtime/src/webmcp.ts`) is a separate adapter
and needs its own check. Before a portable import, require
`site_transfer_capabilities` to report `portableDomain.empty: true` and advance
the same import operation until its receipt reports `verification: "verified"`.

## What proves a capability is active

The starter, the active bundle, and the public route are separate states.

| Capability        | Active bundle proof                                                                  | Live proof                                                         |
| ----------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Tenant SQLite     | Protected `/_tedix/internal/database-runtime` reports `activeBundle.databaseAdapter` | A page `200` proves reachability, not the adapter                  |
| Responsive images | `get_site_overview.mediaRuntime` is `unverified` until the bundle is inspected       | Distinct `srcset` transform URLs and successful `/_image` replies  |
| Agent CMS tools   | Tool-schema sync writes the base `cms` `app_tools` rows; a Worker deploy does not    | Call the tenant `cms_*` tool; an older bundle may lack the route   |
| Locale routes     | Both starters compile explicit routes for nondefault locales                         | Check title, links, archive, Markdown mirror, canonical per locale |

The database diagnostic requires `X-Tedix-CMS-Internal-Auth` and reads the
adapter from the bundle's compiled `virtual:emdash/config`. Keep Astro's page
fallback map empty: its fallbacks redirect instead of rendering a translation.

## Emdash version and patches

The starters pin Emdash and `@emdash-cms/cloudflare` to one release line; keep
manifests, snapshot, plugin peer ranges, and lockfiles aligned. Existing
bundles keep their compiled version until rebuilt; before activating a new
release for a tenant, check its migrations against that tenant's data.

Patches live in `patches/emdash@1.1.0.patch` and
`patches/@emdash-cms/cloudflare@1.1.0.patch` (root is canonical; starters copy
them, checked by `apps/cms/src/emdash-patches.test.ts`).
`worker-loader-do-sql-runtime.ts` in each starter forks the DO SQL dialect.
Delete a hunk only when its fix ships in the release the starters pin:

| Hunk                                                                 | Upstream                                  | Delete when                                     |
| -------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------- |
| `transaction.ts` `supportsTransactions === false` and deletion guard | emdash-cms/emdash PR #1394                | Released and our dialect sets its marker        |
| `SandboxRunner.validateBundle` before registry writes                | Discussion #3635                          | Hook released                                   |
| Failed `plugin:install`/`plugin:activate` hook fails install/update  | PR #3634 (our hook-must-exist rule stays) | #3634 released                                  |
| Draft-content authorization on MCP and REST reads                    | Local                                     | Equivalent upstream authorization verified      |
| Import blocker `collection_deletion_unfinished`                      | Issue #3637                               | Fix released                                    |
| DO SQL stub resolver (the whole dialect fork)                        | Discussion #3636                          | Resolver released                               |
| Exact `@cloudflare/kumo` peer                                        | Issue #3638, PR #3658                     | Published with a peer range                     |
| Canonical sitemap URLs (`X-EmDash-Sitemap-Canonical: 1`)             | Not filed                                 | Upstream passes `emdash-sitemap-canonical.test` |

Not filed yet: external-auth first-user role, missing registry bundle in R2,
import/seed fencing, taxonomy locale fallback, marketing layout-prefetch
removal. After changing patches, regenerate lockfiles and the snapshot and
prove a fresh install.

Emdash contracts Tedix relies on:

- Plugin routes authenticate but do not authorize: each route checks
  `routeCtx.user.role` itself (lead export needs ≥ 40, Editor).
- Locked plugins default-export id-less `{ routes }`/`{ hooks }`; see
  `apps/cms/AGENTS.md` before adding an `id`.
- Importing `EmDashDB` pulls `lib.dom` into the parent's types; type buffered
  bodies as `Uint8Array<ArrayBuffer>`.
- Schema API updates replace the whole `admin` object; preserve `listColumns`.
- Cleanup hooks (`content:afterDelete`, `content:afterUnpublish`) must be
  idempotent.
- Tenant `/_emdash/api/mcp` accepts only Emdash bearer tokens. Site Builder
  forwards with the org's Emdash service key (`cms_provision_service_key`) via
  `callTenantMcpTool` and falls back to the multipart media route without one;
  the negotiated protocol is cached per endpoint for ten minutes and
  `tools/call` is never resent.

## Plugin trust and registry

Locked Tedix plugins are gated by `bun run cms:plugin-trust:validate`, which
compares both starters and the snapshot against the reviewed `declaredAccess`
contract. The registry (minimum release age `72h`) is part of the locked
template; installs need native `plugins:manage`. `registry_status` reports
installs as unverified until a signed install on a disposable canary passes, so
keep customer-site registry installs held. The supported subset adds only
plugin-owned `ctx.kv` through the parent bridge
(`apps/cms-runtime/src/tenant-plugin-executor.ts`).

## Site lifecycle

Sites are managed through Tedix OS Sites and the `sites` API, never with direct
Cloudflare access. Organization scope always comes from the authenticated
context.

- **Create** reserves a quota-counted site ID in a non-serving `provisioning`
  state, creates and rereads the media bucket under an exact-site permit, and
  activates only after readback. A retry reuses the reservation; an
  unobserved provider outcome leaves an orphan permit that blocks teardown
  until reconciled. Paused sites count against `maxCmsSites`.
- **Archive/restore** pause and reactivate the same resources without deleting
  data. **Reconcile** reports drift and never repairs automatically.
- **Deprovision** (exact slug) runs `CmsDeprovisionWorkflow`. Builder and
  runtime each verify a paused site and matching receipt before touching
  provider data; missing resources count as removed on retry, and it is not
  complete while a custom hostname remains at Cloudflare.
- **Custom hostnames** activate only after Cloudflare reports hostname and SSL
  active, and set `custom_domain` and `canonical_url` together; a replacement
  keeps the old hostname until the new one is live.

### Restore fences and recovery

`cms_restore_fences` and `cms_restore_permits`
(`packages/db/src/queries/cms-restore-fences.ts`,
`apps/cms-runtime/src/tenant-restore-fence.ts`) give exact-site admission to
every tenant write path: Loader requests, scheduled runs, SQL/R2/KV/AI Search
RPCs, plugin KV, Builder publish and rollback, hot-theme writes, media repair,
and recovery purge. Each holds a permit around its provider work. Closing a
fence rotates the site's restore epoch, so callbacks from before the close
cannot regain write authority. No timeout reopens a fence; an uncertain nested
permit keeps the site closed for reconciliation. Builder deploys pin the
immutable site ID, so an old queued job cannot publish into a reused slug.

`CmsRecoveryWorkflow` (`apps/cms-runtime/src/cms-recovery-workflow.ts`,
`tenant-media-backup.ts`) captures a SQLite PITR bookmark plus a verified copy
of the media bucket, pausing scheduled writes for that site during the SQL
digest. Captures expire 29 days after the bookmark, inside the PITR horizon.
Owner restore (`startCmsSiteRestore`) closes the fence, drains permits, takes an
undo capture, and releases only after SQL, media, and bundle match the target.
Capture does not freeze tenant edits, and owner manifests stay
`recoverable:false` until a site-specific capture is verified.

## Deploy workflow

`theme_deploy` is asynchronous; poll `theme_deploy_status({ jobId })`.

1. `preflight` materializes the starter, applies the `sourceCommit` source,
   restores locked files, and pins the editable-source digest.
2. `build-theme` builds in a private per-attempt workspace and fails if the
   source differs from the pin. The Builder workspace is never the source for
   an Artifacts-backed deploy.
3. `snapshot-theme` stages the bundle under a per-attempt prefix, rebuilding if
   a Sandbox reset lost the output. If Sandbox control stops responding, wait
   for the Workflow to finish and reconcile the build process and permit first.
4. `publish-bundle` writes and activates the bundle; `health-check` rolls back
   on failure; `cleanup-staging` runs after both settle.

## SEO ownership

Native Emdash owns per-entry SEO, `EmDashHead` metadata, `/robots.txt`,
sitemaps, and `hreflang`. Tedix adds only the `tedix-seo-aeo` plugin (site
owner identity, breadcrumbs, FAQ, enriching the native graph under its
`primary` key rather than competing with it), `/llms.txt`, Markdown mirrors,
`/rss.xml`, and the `tedix-tedi-bridge` publish hook. Plugins derive links from
the collection `urlPattern`, never a hardcoded `/posts/*`.

## Checks

| Change                                   | Check                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Database adapter or runtime bindings     | `bun run cms:database-architecture:validate`; live: `cms:database-architecture:validate -- --live --json` |
| Starter Emdash version or locked plugins | `cms:emdash-release:validate`, `cms:plugin-trust:validate`, `bun apps/cms/scripts/build-templates.ts`     |
| Responsive images (responsive-media)     | `cms:responsive-media:validate`                                                                           |
| Scheduler                                | `cms:scheduler:validate`                                                                                  |
| Site Builder MCP tools                   | A call through the affected tenant namespace                                                              |
