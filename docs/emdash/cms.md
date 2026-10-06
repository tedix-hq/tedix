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

Emdash is the tenant CMS runtime behind Tedix blogs and content sites. The
parent Worker (`apps/cms-runtime`) resolves the tenant, loads the active bundle
from R2, and injects the tenant's Durable Object SQLite database, R2 media, KV
session, auth, branding, routing, and SEO settings into that bundle through
Worker Loader. `apps/cms` (Studio / Site Builder) owns the MCP tools, the
preview sandbox, and the build/deploy workflow.

## Runtime shape

| Layer              | Owns                                                          | Handle                                                   |
| ------------------ | ------------------------------------------------------------- | -------------------------------------------------------- |
| `apps/cms-runtime` | Host routing, tenant lookup, Worker Loader, injected bindings | `apps/cms-runtime/src/index.ts`                          |
| `apps/cms`         | MCP tools, preview sandbox, build/deploy workflow             | `cms_*` tools, `apps/cms/src/agent/tools.ts`             |
| Tenant bundle      | Astro + Emdash site code, locked plugins, theme files         | Active row in `tenant_bundles`, compiled files in R2     |
| Tenant data        | Emdash `ec_*` tables, media, settings                         | EmDashDB Durable Object named by slug, per-tenant bucket |

Invariants:

- **Active bundle lookup** is `tenant_bundles WHERE slug = ? AND is_active = 1`.
  A deploy uploads `{slug}/v{N}/manifest.json` and modules to R2, then flips the
  active row. Bundles are immutable.
- **Every bundle records one source identity**: the full Artifacts Git commit
  passed as `sourceCommit`, or else the SHA-256 digest of the complete editable
  source set. Older rows may have `sourceRevision: null`; never infer one.
- **Durable Object SQLite is the tenant database.** Starters use the
  Worker-Loader-safe `durableObjects({ binding: "DB_DO", name:
process.env.ORG_SLUG, session: "auto" })` descriptor; the parent declares
  `EmDashDB` and injects `DB_DO` as a serializable RPC stub. Activation checks
  the compiled adapter; rollback refuses bundles built for another adapter.
- **Native bindings stay in the parent.** Worker Loader isolates cannot receive
  native R2, KV, Images, or AI Search bindings, so the parent serves `/_image`
  itself and injects narrow RPC facades (for example `TenantR2`).
- **The Worker Loader cache key** includes the bundle version, R2 prefix,
  entrypoint, module manifest, etag, tenant metadata, and fingerprints of the
  runtime values injected into the isolate
  (`apps/cms-runtime/src/tenant-cache-key.ts`). Rotating an injected value
  evicts loaded isolates.
- **No global in-flight promise caches** in runtime or theme helpers. Cache
  resolved values or use bounded single-flight; a cancelled request must not
  leave a shared promise pending.
- **Shared parent response caching is disabled** until tenant-keyed caching is
  proven; tenant HTML is served `private, no-store`.

### Secrets and privacy in the parent

- **Plugin secret settings** (`type: "secret"`) are encrypted by Emdash. The
  parent holds one master key (`EMDASH_ENCRYPTION_KEY`) and derives a distinct
  per-site key with HMAC-SHA-256 over `tedix-emdash-settings:v1:<site-id>`
  (`apps/cms-runtime/src/tenant-emdash-encryption.ts`). Only the derived key
  reaches the tenant isolate. The immutable site ID keeps settings readable if
  the slug changes. Rotation: store `new,old`, re-save tenant secret settings,
  verify, then drop the old key. Losing the master makes encrypted settings
  unreadable.
- **Lead-form IP pseudonyms.** The parent trusts the connecting IP only on a
  real Cloudflare request, derives a tenant-scoped HMAC under
  `LEAD_FORM_IP_HASH_HMAC_KEY`, and overwrites `X-Tedix-Lead-IP-Hash`. Plugins
  store only the `h1:` pseudonym and never see the key; the submit route fails
  closed when the key is missing.

## Agent mental model

Each site is **code that renders content**.

| Concept          | Emdash                                                                                             | Tedix CMS                                                                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Theme            | A complete Astro project copied into the site; no runtime inheritance.                             | Editable tenant source plus locked platform files. `theme_*` tools edit, preview, build, deploy, and roll back.                                                                                                                  |
| Starter template | Project copied at creation; its seed initializes the content model once.                           | Supported scaffolds under `apps/cms/templates/`, selected by strict `templateSlug` (catalog: `packages/api-contract/src/schemas/cms-template.ts`). Locked files are restored at deploy from `apps/cms/src/template-snapshot.ts`. |
| Plugin           | Code adding routes, hooks, fields, or blocks. Native plugins run with host access.                 | The supported starters include native upstream embeds and forms; existing immutable tenant bundles gain them only when rebuilt. Registry execution is canary-gated.                                                              |
| Content          | Collection entries with fields, status, revisions, media, menus, settings, stored apart from code. | Per-site EmDashDB object and media bucket; `content_*`, `revision_*`, `media_*`, `menu_*`, `settings_*` operate on it. Bundle deploys never publish drafts or overwrite content.                                                 |

An agent codes the Astro theme and components; an editor changes entries and
settings. Marketing sites render ordered, versioned native Emdash block types
in `pages.content` through `<Blocks>` from `emdash/ui`
(`apps/cms/templates/marketing/src/components/MarketingBlocks.astro`). A seed
change never migrates an existing site's content or active bundle.

### Operating path

1. **Read first.** `cms_*.get_site_overview` returns settings, collections,
   menus, plugins, runtime health, `templateSlug`, public URL, active bundle
   version, source revision, and hot CSS revision. Use `theme_list_versions`
   for history and `theme_list_files` for locked/editable paths.
2. **Editorial changes** use `content_*` and related tools: draft, preview,
   publish or schedule, then verify the public route. Restoring a revision
   creates a draft; publish it explicitly.
3. **Small CSS changes** use the hot theme (served at `/_tedix/theme.css`).
   Markup, components, or behavior changes edit the full source set, preview,
   deploy with `theme_deploy({ sourceCommit })`, poll status, and verify the
   live page.
4. **Platform changes** edit the shared starter, regenerate the embedded
   snapshot, deploy Studio, then propagate to intended sites with
   `template_propagate`. A starter edit alone never updates active bundles.
5. **Site lifecycle** runs through Tedix OS Sites or the `sites` API (below).

### Version identities

| Changed object     | Identity                                                                     | Rollback                    |
| ------------------ | ---------------------------------------------------------------------------- | --------------------------- |
| Content entry      | Native Emdash revision (`revision_list`); `revision_restore` returns a draft | Restore, then publish       |
| Theme source       | Artifacts commit when `sourceCommit` is passed, else editable-source digest  | Restore source and redeploy |
| Live compiled site | Bundle version and `sourceRevision` in `theme_list_versions`                 | `theme_rollback`            |
| Live CSS override  | Hot-theme R2 revision                                                        | `rollback_hot_theme`        |

A source commit is not proof the matching bundle is active, and a successful
build is not proof of the public route. Read back the live bundle version and
route after every deploy.

For a bundle identified only by an editable-source digest, call
`theme_workspace_status` before preserving the Builder workspace in Artifacts.
Seed from that workspace only when its complete editable-file digest matches
the active bundle. Verify the resulting Artifacts commit has the same digest
before using it for a deploy. A drift or unavailable result means the active
source has not been recovered; do not reset the sandbox or deploy a replacement
source.

## What proves a capability is active

The starter, the immutable active bundle, and the public route are separate
states.

| Capability        | Source configuration                                                                                                                                                 | Active bundle                                                                                | Live behavior                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Tenant SQLite     | `apps/cms-runtime` Durable Object SQLite adapter                                                                                                                     | Protected `/_tedix/internal/database-runtime` reports `activeBundle.databaseAdapter`         | A page `200` proves reachability, not the adapter                                          |
| Responsive images | Both starters use Emdash `images: true` and Astro `cloudflare-binding`; source validation checks the snapshots, parent binding/route, and prefix-scoped media origin | `get_site_overview.mediaRuntime` reports `unverified` until the compiled bundle is inspected | Distinct transform URLs in a published image's `srcset` and successful `/_image` responses |
| Agent CMS tools   | `apps/cms/src/agent/tools.ts`                                                                                                                                        | Catalog sync materializes the base `cms` `app_tools` rows; a Worker deploy alone does not    | Call the tenant `cms_*` tool; an older bundle may lack the route                           |

The database diagnostic endpoint requires `X-Tedix-CMS-Internal-Auth` (or a
bearer token) equal to the runtime's internal token and reads the adapter from
the bundle's compiled `virtual:emdash/config` module.
The repository database-architecture validator checks the source side (starter
adapter, runtime bindings, diagnostic, and this doc); its live mode also checks
the routes and the diagnostic's reported adapter.

Both starters compile explicit routes for nondefault locales. The public
locale prefix selects the original content locale through Astro rewrites for
home, pages, posts, and category/tag archives; Markdown mirrors dispatch the
locale in the catchall endpoint because Astro prioritizes that endpoint over a
dynamic locale Markdown route. Keep Astro's page fallback map empty: its
fallback routes redirect to the default-language page and cannot render a
published translation. A localized index returning `200` is insufficient proof:
check the requested locale's title, post links, category archive, Markdown
mirror, and canonical URL in the active tenant bundle.

## Emdash version and upgrades

The shared starters pin Emdash and `@emdash-cms/cloudflare` to one release line
(`apps/cms/templates/*/package.json`). Keep the starter manifests, embedded
snapshot, local plugin peer ranges, and lockfiles on that line. Validate package
alignment and plugin trust before bundle activation.

Existing bundles keep their compiled Emdash version until rebuilt and
activated. Before activating a new release for a tenant, inspect it for schema
migrations that touch its data (reference fields, taxonomies, datetime values),
and read back its compiled version after a controlled rebuild. Tedix carries
patches for the Worker Loader transaction path, guarded collection deletion,
import/seed fencing, and locale-aware taxonomy archive filters. Category and tag
archives keep the requested content locale
when a term has no translation, using its fallback slug for the same term
group. A term translated in the requested locale matches its translated slug.

### Local patches

The patches live in `patches/emdash@1.1.0.patch` and
`patches/@emdash-cms/cloudflare@1.1.0.patch`, copied under
`apps/cms/templates/*/patches/`. `worker-loader-do-sql-runtime.ts` in each
starter forks the Emdash DO SQL dialect. Delete a row's hunks when the upstream
item ships in a release the starters pin. Emdash 1.1.0 includes the logical
SQLite changed-row count from [PR #3633](https://github.com/emdash-cms/emdash/pull/3633),
so that local hunk is gone.

| Hunk group                                                                                         | Upstream                                                                                                                                                                           | Delete when                                                           |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `transaction.ts` `supportsTransactions === false` short-circuit                                    | [PR #1394](https://github.com/emdash-cms/emdash/pull/1394) (existing; adapter marker)                                                                                              | #1394 released and our dialect sets its marker                        |
| Collection-deletion `registry` guard action (D1 batch, DO `transactionSync`)                       | None filed. Both registry-phase statements are already lease-fenced upstream; the patch only avoids the `withTransaction` probe                                                    | Same as the `transaction.ts` row                                      |
| `SandboxRunner.validateBundle` before registry install/update writes                               | [Discussion #3635](https://github.com/emdash-cms/emdash/discussions/3635) (feature, needs maintainer approval)                                                                     | Hook released                                                         |
| Failed `plugin:install` / `plugin:activate` hook must fail install/update (`requireLifecycleHook`) | [PR #3634](https://github.com/emdash-cms/emdash/pull/3634) (rejects on hook failure). Our extra rule, which also requires the install hook to exist and run on update, stays local | #3634 released; keep the existence rule                               |
| Draft-content authorization on MCP and REST reads                                                  | Local protection                                                                                                                                                                   | Equivalent authorization verified in the pinned upstream release      |
| Import blocker `collection_deletion_unfinished` and `clear_scaffold` `wait` on `CONFLICT`          | [Issue #3637](https://github.com/emdash-cms/emdash/issues/3637)                                                                                                                    | Fix released                                                          |
| DO SQL stub resolver (the whole `worker-loader-do-sql-runtime.ts` fork)                            | [Discussion #3636](https://github.com/emdash-cms/emdash/discussions/3636)                                                                                                          | Resolver released; delete the fork                                    |
| Exact `@cloudflare/kumo` peer `2.6.0` in the adapter and forms plugin                              | [Issue #3638](https://github.com/emdash-cms/emdash/issues/3638), [PR #3658](https://github.com/emdash-cms/emdash/pull/3658)                                                        | Published with a peer range; the local adapter patch accepts `^2.6.0` |

Not filed upstream yet: external-auth role on first user, a hard failure when a
registry bundle is missing from R2, import/seed fencing, taxonomy locale
fallback in `loader.ts`, and the marketing starter's layout-prefetch removal.

The remaining hunks are functional adapters or correctness fixes against the
pinned release, not a theme customization layer:

- **Hosting:** transaction and collection-deletion adapters preserve Worker
  Loader RPC boundaries; registry validation and lifecycle checks preserve the
  deliberately restricted plugin host.
- **Editing:** external-user role/concurrency handling, draft visibility,
  stored-block validation during publish/restore, and atomic REST menu writes
  preserve native editing semantics on the hosted path.
- **Content delivery and transfer:** taxonomy fallback, canonical sitemap URLs,
  unfinished deletion checks, and import/seed fencing preserve published URLs
  and resumable imports.

Root patches are canonical. The `tedix` starter copies them unchanged; marketing
adds only anonymous layout-prefetch suppression. Generated `.bun-tag-*` cache
markers do not belong in patches. `apps/cms/src/emdash-patches.test.ts` checks
starter parity. After changing patch files, regenerate affected lockfiles and
the template snapshot, then prove a fresh install before activation. An upstream
main-branch fix alone is not a reason to remove a hunk from a pinned release.

Contracts Tedix relies on:

- **Plugin routes authenticate but do not authorize.** Private routes receive
  `routeCtx.user` (`{ id, email, name, role, createdAt }`), `undefined` for
  public routes and unbound machine tokens. Each plugin route must check role
  itself; lead listing and CSV export require role ≥ 40 (Editor). Role levels
  are `10 | 20 | 30 | 40 | 50`.
- **Locked Tedix plugins default-export id-less `{ routes }` / `{ hooks }`
  objects**, which keeps them on the two-argument `(routeCtx, pluginCtx)`
  convention. Do not add an `id` without converting the handlers.
- **Importing `EmDashDB` pulls `lib.dom` into the parent Worker's types.**
  Buffered response bodies must be typed `Uint8Array<ArrayBuffer>`.
- **Plugin settings** use top-level `settingsSchema`, stored in each plugin's
  `settings:` KV namespace and read at runtime. Network calls go through
  capability-gated `ctx.http.fetch`.
- **Cleanup hooks** (`content:afterDelete`, `content:afterUnpublish`) run to
  completion and must be idempotent.
- **Routable collections** require a slug on published entries; internal-only
  collections set `routable: false`.
- **Schema API updates replace the whole `admin` object**; preserve
  `listColumns` when changing navigation or quick-create settings.
- **Postgres/Hyperdrive is not supported** for tenants: it lacks cron,
  scheduled publishing, plugin cron, plugin-context queries, media providers,
  and sandboxed plugins, all of which Tedix uses.

### AI Search

Emdash's `aiSearch()` plugin indexes published and scheduled content and serves
`POST /api/ai-search`. First enablement needs an explicit **Sync All Content**;
hook-driven indexing is eventually consistent. The parent owns the native
`AI_SEARCH` binding and injects a tenant-pinned facade that maps the one
logical instance name to a derived private instance and exposes only
`get`/`create`, instance `info`/`update`/`search`, and item `upload`/`delete`.
Namespace inventory, delete, chat, jobs, and cross-instance search are not
exposed.

### Media upload over MCP

The tenant `/_emdash/api/mcp` endpoint accepts bearer tokens only. Site Builder
forwards `media_upload` natively with the organization's stored Emdash service
key (bootstrapped by `cms_provision_service_key`) and keeps the public
`dataBase64`/`mimeType` contract. Without a key it falls back to the
authenticated multipart `/_emdash/api/media` route and chains `media_update` for
`alt`/`caption`. Content-hash dedupe reuses an existing record, so changing its
`alt` needs `media_update` and edit permission on that record.
`media_to_field_value({ mediaId })` builds a stored image value with key,
dimensions, focal point, and placeholder.

Native forwarding (`callTenantMcpTool` in `apps/cms/src/agent/cms-proxy-runtime.ts`)
uses the MCP SDK v2 client with `versionNegotiation: 'auto'`. Released Emdash
serves only the 2025 revision and rejects the `server/discover` probe with a
400, which the client treats as a legacy signal and answers with `initialize`.
The verdict is remembered per tenant endpoint for ten minutes and evicted on
any failure, so a warm call is `initialize`, `notifications/initialized`,
`tools/call`. `tools/call` is never resent.

### Plugin registry

The starter enables the Emdash plugin registry (`https://registry.emdashcms.com`,
minimum release age `72h`) in `astro.config.mjs`; registry policy is part of the
locked template. Registry installs, updates, and uninstalls require native
`plugins:manage` and go through `cms_*.plugin_install` / `plugin_update` /
`plugin_uninstall`; inventory through `registry_status`, `plugin_list`,
`plugin_get`, `plugin_updates`. Locked Tedix plugins are gated by
the plugin trust check, which compares the starter, snapshot, and
reviewed `declaredAccess` contract. `registry_status` reports installation
as unverified: the parent runtime supports an exact-site canary plugin host,
but no signed zero-access install hook and private route proof has passed.
The supported registry subset includes native plugin-owned `ctx.kv` operations,
including versioned compare-and-set/delete, through the parent-pinned tenant and
plugin bridge (`apps/cms-runtime/src/tenant-plugin-executor.ts`). These require no
native manifest capability. The bridge still rejects settings keys and broader
host access; network, structured storage, admin extensions, MCP, and additional
hooks are not supported by this subset. KV calls retain invocation expiry and
restore fencing. Local Workers tests prove persistence and tenant/plugin isolation;
that is separate from a signed registry install on the deployed canary.
Keep customer-site registry installs held until that disposable proof. After a
registry plugin change, run a tenant route check and a draft-only MCP write
check before publishing.

## Scheduling

The starter's `src/worker.ts` re-exports `default` and `PluginBridge` from
`@emdash-cms/cloudflare/worker` and `EmDashDB` from
`@emdash-cms/cloudflare/db/do-sql`, and its `wrangler.jsonc` has a one-minute
cron. Regenerate `apps/cms/src/template-snapshot.ts` after changing either.

In production, the parent Worker owns the cron: `apps/cms-runtime` lists active
`tenant_bundles`, loads each bundle, and calls its Emdash `scheduled()`
handler. Check the scheduler after a Worker change.

## Site lifecycle

CMS sites are managed from Tedix OS Sites and the `sites` API, not as MCP apps
and not with direct Cloudflare access.

- **Create.** An organization admin with `settings:manage` calls
  `sites.createCms({ slug, name, templateSlug })`; an agent with
  `mcp:content.admin` calls `sites.create_cms_site`. It creates or verifies the
  authoring proxy, atomically reserves a quota-counted site ID in the
  non-serving `provisioning` state, then creates and rereads the media bucket
  under an exact-site D1 permit. Only that site's conditional update activates
  it after provider readback. A provider failure leaves the same reserved site
  for a matching retry; an unobserved create outcome leaves an orphan permit
  that blocks teardown until reconciled. A foreign or mismatched slug conflicts. The
  number of sites is limited by the organization's `maxCmsSites` feature
  (`sites.list` returns usage and limit); paused sites count until
  deprovisioned. A new site is unpublished until its first theme deploy.
- **Archive / restore.** Archiving pauses the `cms_sites` row and disables the
  authoring proxy without deleting any data. Restore reactivates the same
  resources; it cannot activate a `provisioning` site.
- **Reconcile.** Reports missing proxies, bundles, media buckets, or
  conflicting hostnames; it never repairs automatically. Platform admins can
  create a missing media bucket with `sites.repair_cms_media` (idempotent,
  only after provider readback confirms absence).
- **Deprovision.** Requires typing the exact slug. `sites.deprovision`
  reserves an organization-scoped operation and dispatches
  `CmsDeprovisionWorkflow`, which records status, stage, removed resources, and
  errors in `cms_deprovision_operations`; poll `sites.getDeprovisionStatus`.
  The Workflow carries the immutable site ID to Builder, which verifies a
  paused canonical site and matching running receipt before provider cleanup.
  Builder forwards that ID to runtime; both Durable Object and media-bucket
  deletion repeat the exact-site receipt check before touching provider data.
  Order: disable app and proxy; remove custom hostnames; delete the tenant
  Durable Object storage; remove media, published bundles and static assets,
  site-owned staging and deploy status, Site Builder state, service key, and
  sandbox; detach the proxy from the aggregate gateway; delete the
  proxy and app records. Missing resources count as removed on retry; provider
  permission errors fail explicitly. Organization scope comes from the
  authenticated context, never from input. Deprovision does not report complete
  while a known custom hostname remains at Cloudflare.

The recovery manifest and deprovision plan ask the runtime for a tenant storage
probe. Unverifiable resources are reported as unknown, and unverified Durable
Object storage blocks a positive recovery claim.

Owner-scoped Sites recovery operations can now start a private capture, inspect
its status, and explicitly purge it by site ID and capture ID. The runtime
captures an Emdash SQLite Durable Object PITR bookmark and streams every object
from the site's media bucket into the separate `recovery/<site-id>/<capture-id>/`
prefix in the recovery R2 bucket. Each copied object is reread and
checked by size and SHA-256; the source is read again and checked by SHA-256,
inventory, active bundle, and a second full SQLite digest. A new v2 manifest
containing the first PITR bookmark, its coupled full SQL digest, and a digest
algorithm identifier is written only after those checks pass. New captures
compare SQL content rather than opaque bookmark strings, which can advance
while stored rows remain unchanged. Existing v1 captures remain readable and
purgeable through their retention window; no new v1 manifest is written. API
status excludes the bookmark and object keys. V2 capture does not freeze
tenant edits or media writes, and it does not authorize customer restore.
Before its first SQL digest, `CmsRecoveryWorkflow` claims a one-hour exact-site,
exact-capture D1 scheduled-write pause and drains already admitted scheduled
runs. The scheduler's single D1 permit admission checks that pause before it
may call Emdash `scheduled()`; unrelated sites continue. The workflow checks
the live pause again before publishing the private manifest. Capture-only media
pages contain at most ten objects, so a failed page can resume from a smaller
Workflow checkpoint while the full source and destination inventory digests
still cover up to 10,000 objects. Pause claim, drain, release, and final control
verification have durable Workflow steps. A transient step failure leaves the
exact-site pause and running control intact for replay; only a completed
release is followed by a verified control record. An interrupted pause expires
after one hour, after which scheduled work resumes and the incomplete capture
cannot verify. Owner status derives a terminal failure from Workflow status
while provider history is available; an unresolved old capture becomes unknown
when that history expires and can be explicitly purged. The full SQL digest
fails closed above its bounded database, row, byte, or time limits. A private
control record preserves verified status and purge authority after Workflow
history expires; a partial purge marks the capture
unusable before deleting media and can be retried. Capture status becomes
expired 29 days after the first database bookmark, inside the Durable Object
PITR horizon, even if the bytes remain until the owner purges the capture. A
completed deprovision receipt preserves the original organization's purge
authority after the site row is removed. The fixed disposable-site drill is
installation-specific validation, not a customer restore operation. It exercises
SQLite PITR restore, undo, final baseline digest comparison, and streaming media
roundtrip with byte and HTTP metadata checks. Capture IDs, operational receipts,
and live deployment evidence belong in the installation's private change record.
This does not establish recovery for customer sites; without a verified
customer-specific capture, owner manifests correctly remain `recoverable:false`.

The platform D1 `cms_restore_fences` and `cms_restore_permits` tables provide
exact-site admission for tenant Worker Loader requests and scheduled runs
(`packages/db/src/queries/cms-restore-fences.ts`,
`apps/cms-runtime/src/tenant-restore-fence.ts`). Each invocation enters an
atomic permit; an exact site close denies new permits and a release requires
the same generation and capture ID with zero permits. Fence close atomically
rotates a persisted site restore epoch. Tenant Loader capabilities, internal
service auth, and new permits carry the epoch captured at dispatch; callbacks
from before the close cannot reacquire write authority after release. Permits
record `outer` or `nested` origin. Historical untyped permits remain `legacy`
and still count toward drain; an uncertain nested operation keeps the site
closed for explicit reconciliation. Under an exact rotated fence, the restore
Workflow may reclaim stale `outer` permits only after every `nested` and
`legacy` permit for that immutable site ID has drained. No timeout reopens it.
Site Builder bundle publication and
manual or health-failure rollback also acquire an exact-site permit before
their first live mutation. Publication holds it through bundle activation,
static R2 writes, and the status receipt; rollback holds it through the final
readback. A queued build may finish while a site is closed, but its publish
step cannot begin. Hot-theme write and rollback also hold an exact-site permit
from before their first R2 read until all CSS/history writes and the D1
metadata update settle. Tenant SQL query/batch/deletion-guard RPCs, R2
put/delete, and session KV put/delete
now carry pinned site ID, slug, and restore epoch into the parent Worker and acquire a nested
permit around each underlying operation. The SQL retry pattern identifies
plain SELECTs for diagnostics only; every SQL RPC gets a permit. R2 uploads
hold theirs until the stream transfer and stored-object size readback finish.
AI Search instance creation, updates, and item writes also hold exact-site
permits around the native binding call. Tenant outbound HTTPS calls and plugin KV set, compare-and-set, and
deletes hold them around the Durable Object query itself, including calls still
running after a plugin invocation times out. Existing-site media repair uses
an explicit internal repair intent and holds an exact-site permit through the
provider bucket inspection and creation. Media creation uses a separate exact
site-ID provisioning permit after the quota-counted row is reserved. The
permit is retained when the provider create outcome cannot be observed; the
deprovision drain then requires reconciliation. A deprovision receipt now reserves its exact site ID,
organization, and slug against restore close. Once reserved, new tenant and
Builder permits are denied, including after a failed deprovision attempt.
The deprovision Workflow drains all admitted permits for that site before it
pauses routing or calls a provider; an orphan permit leaves a durable failed
receipt and requires reconciliation. Builder deploy admission now pins the
immutable site ID in its Workflow payload and bounded instance ID, so a queued
old job cannot publish into a new site that reuses the slug. Each preflight,
build, snapshot, publish, health check, cleanup step, and R2 status receipt
holds an exact-site permit through its awaited provider work. Concurrent
staging, bundle, and static R2 uploads all settle before a permit releases on
failure. An unobserved timed-out Sandbox process retains an orphan permit
and blocks deprovision until its outcome is reconciled. Direct internal deletion
requires a paused exact site and matching running deprovision receipt at
Builder and runtime; provider writes do not begin when those checks fail.
Teardown purges published static assets, site-owned staging and exact-site
deploy status objects, and waits for concurrent media-object deletions before
reporting an error. Historical slug-only deploy statuses have no provable
ownership after slug reuse and are retained. Media creation reserves a
non-serving, quota-counted `provisioning` site before provider writes and
activates only that exact site after readback. Recovery capture purge on a
current site holds an exact-site permit through private object deletion; a
restore close drains an admitted purge, and a closed fence denies new purges.
After site removal, purge requires its succeeded deprovision receipt.

The owner-scoped `startCmsSiteRestore` and `getCmsSiteRestore` operations now
accept only an exact active site, slug confirmation, and verified unexpired v2
capture. The runtime claims a private generation receipt outside the capture
purge prefix, closes the D1 fence, drains permits by immutable site ID, takes a
fresh verified undo capture, and records one-shot PITR intent before each
provider schedule. SQL, the complete media set (keys, bytes, SHA-256, and HTTP
metadata), and the active bundle must match the target or roundtrip undo before
exact fence release. The parent Worker gates marketing, redirects, hot theme,
WebMCP, static assets, image transforms, and Loader traffic before serving;
public response creation and each stream pull hold separate epoch-pinned
permits through body enqueue or cancellation. An abandoned, unread response
body leaves no permit; a later pull from an older epoch is denied.
Already cached CDN bytes are outside that Worker gate. Unknown provider effects
leave the exact site closed for operator reconciliation. Owner status exposes
only phase and bounded error code, never bookmarks or media keys. Customer use
needs each organization's authority, current verified capture, and
explicit reconciliation of any historical permits; customer manifests remain
`recoverable:false` until that site-specific proof exists.

The capture contract is enforced by
`apps/cms-runtime/src/cms-recovery-workflow.ts`,
`apps/cms-runtime/src/tenant-media-backup.ts`, and the owner-scoped
`apps/api/src/rpc/routers/sites.ts`.

### Custom hostnames

An active site can claim a verified subdomain or DNS zone apex through Sites or
`sites.beginCmsDomain` / `getCmsDomain` / `verifyCmsDomain` /
`removeCmsDomain` (MCP: `begin_cms_domain`, `get_cms_domain`,
`verify_cms_domain`, `remove_cms_domain`). Mutations require `settings:manage`
(and `mcp:content.admin` over MCP); new claims also require the organization
`customDomain` feature. Removal stays available after a plan downgrade.

Begin returns a seven-day pending claim with `claimId`, `txtName`, `txtValue`,
and `cnameTarget`. Publish the ownership TXT record. A subdomain needs a public
direct CNAME to `cnameTarget`; a zone apex can use the DNS provider's CNAME
flattening or apex alias and is checked by an exact SOA answer at the claimed
hostname. Verify the claim, retry while it reports `provisioning`, and publish
any extra TLS validation records Cloudflare returns. The claim activates only
after Cloudflare reports both hostname and SSL active. Activation sets
`cms_sites.custom_domain` and `canonical_url` together. A replacement keeps
the old hostname until the new one activates. Removal stops routing, restores
the platform canonical URL, and deletes the provider hostname; an interrupted
deletion leaves a `removing` claim to retry. A hostname that predates claims is
adopted as active only after exact Cloudflare readback confirms the record and
active SSL.

For an active DNS zone apex, Sites offers a separate **www redirect** setup.
`sites.beginCmsDomain` takes `hostname: "www.{apex}"` and
`redirectToApex: true`; `sites.getCmsDomain` with `redirectToApex: true` reads
that companion without replacing the primary claim. The www claim has its own
ownership TXT, direct CNAME, and TLS validation. Verify it with the returned
`claimId`. Once hostname and SSL are active, public GET and HEAD requests
receive an HTTPS 301 to the apex with their path and query preserved. The site
keeps the apex as its canonical URL. Removing www leaves the apex active;
removing or replacing the apex cleans up its old www companion.

## Content operations

Create and update entries through native `cms_*` content tools. Prose may be
supplied as Markdown; use Portable Text JSON when custom blocks need exact
control.

1. Inspect the schema: `schema_get_collection({ slug: "posts" })`.
2. Resolve taxonomy term IDs with `taxonomy_list` / `taxonomy_list_terms`.
3. Create a draft: `content_create({ collection, slug, data, locale })`.
4. Set SEO with `content_update({ collection, id, seo })`; assign terms with
   `content_set_terms({ collection, id, taxonomy, termIds })` (an empty
   `termIds` clears that taxonomy).
5. Publish after review: `content_publish({ collection, id, locale })`.

Rules:

- `content_create` always creates drafts. `slug` is a top-level argument, not a
  `data` field. `seo`, `bylines`, and `publishedAt` are first-class
  `content_update` fields.
- Read list rows from `data.items`. Before retrying an ambiguous create
  (timeout, transport error, missing id), query the slug and locale, reuse one
  exact match, fail on duplicates, and retry at most once.
- `content_create` sends the complete payload in one native create request,
  including media, Portable Text, block arrays and reference selections. Read
  the draft back before publishing. Failed creates are returned without a
  follow-up update or destructive cleanup.
- `search` paginates with `cursor` / `nextCursor`.
- `generate_blog_post_ai({ keyword, language, market, createDraft: true })`
  creates a full draft with native SEO metadata; publish separately.
- `media_generate_image` creates branded imagery as local media and can attach
  it to a field; poll `media_generation_status({ jobId })`.

### Native search activation

A collection's `supports: ["search"]` and searchable fields describe capability;
they do not by themselves activate its full-text index. After defining searchable
fields, call `cms_*.configure_search({ collection, enabled: true })`, then query
`cms_*.search` and verify expected published entries. The binding uses native
`searchEnableBody` and `POST /_emdash/api/search/enable`, including native
`search:manage` permission checks. Optional `weights` and `tokenize` pass through.
Disabling removes the index while preserving content.

Implementation: `apps/cms/src/agent/cms-proxy-tools.ts` and
`apps/cms/src/agent/cms-proxy-runtime.ts`. The visitor WebMCP `search_site` tool
is a separate public adapter in `apps/cms-runtime/src/webmcp.ts`; verify it in
addition to native search. Its bounded fetch budget accommodates native
multi-collection queries; successful native search does not prove that wrapper
or its returned public URLs work. This is distinct from the optional AI Search
integration described above.

### Validation boundaries

Validate the actual workflow rather than inferring support from a toolbar,
collection option or successful build. The native-alignment sprint exercised
draft/publish/revision/Trash workflows, stale revision rejection, actual scheduled
publication and unscheduling, locales and ordered references, inline editing,
media transformations and usage indexing, section/widget operations, package
export and collection search.

Native portable export/import into an empty disposable destination also passed:
settings, collection fields, menus, taxonomies and published content matched.
A populated fixture additionally preserved an uploaded PNG, its image-field
value, English/German translation groups and locale-specific references. Native
verification completed without warnings; independent downloads had identical
bytes and SHA-256 hashes, and the target image value used its remapped storage
key. Schema, menu and settings readbacks matched. Synthetic drafts were moved
to recoverable Trash; their hidden collection and media remain available for
restoration. Original visible content inventory was unchanged. Transfer uses
native operations through `apps/cms/src/agent/cms-proxy-runtime.ts`; successful
export alone is insufficient.

Before importing, require native `site_transfer_capabilities` to report
`portableDomain.empty: true` with no blockers. A public health response does not
prove database readiness or import eligibility. Reuse the same import operation
while copying bounded missing-file pages: an empty cursor after the initial
index upload does not mean all package files are present. Inspect the native
plan, bind its exact package and plan digests, and advance that operation until
its receipt reports `verification: "verified"`. Complete populated-site
onboarding with `complete_existing_setup` instead of applying a starter seed.

That evidence does not establish two-user edit-lock contention, disaster
recovery, fresh external form/email/webhook delivery, arbitrary optional plugin
behavior, or section insertion-copy behavior.
Test these independently when required. An export manifest is not a successful
restore; native JSON backup and the portable `.emdash` transfer package have
different purposes. Preserve real users, access grants and customer content
while choosing disposable fixtures for proof. Validation receipts belong in the
Work record; inspect current tenant configuration before repeating a claim.

## Native theme and index behavior

Both starters use the shared `ThemeInit.astro`, `ThemeControls.astro`, and
`theme-preference.ts` implementation. Initialization applies the exact `theme`
cookie before paint; Light/Dark persist a one-year cookie and System removes
it and follows OS changes. Fixed platform modes ignore the cookie and hide
controls. Custom layouts consume these components rather than copying their
scripts. Keep mode-aware palette overrides in editable `theme.css` using
`light-dark()` and the native root classes; do not pin semantic tokens to
light colors. The marketing source links these modules to their Tedix source;
template packaging materializes the links for isolated builds.

The native post index reads `getSiteSettings().postsPerPage` (an integer from
1 to 100); missing or invalid values use twelve. `blog-pagination.ts` owns
safe page/offset arithmetic and the extra search result used to determine
whether another page exists. Search and collection storage remain native
Emdash APIs.

## SEO and GEO ownership

Native Emdash owns standard SEO: per-entry SEO fields (`hasSeo: true`),
`EmDashHead` metadata (title, description, canonical, robots, OpenGraph,
Twitter, BlogPosting, WebSite), `/robots.txt`, `/sitemap.xml`,
per-collection sitemaps, and `hreflang` alternates. The Emdash 1.1 compatibility
patch includes same-origin per-entry canonical overrides in native sitemap
URLs and alternates, and omits externally canonicalized entries.

### Canonical sitemap patch upgrade contract

Retire the sitemap hunk only when the candidate upstream core passes the
installed endpoint regression tests in `src/emdash-sitemap-canonical.test.ts`:
root canonicals, explicit slash conventions, locale alternates, malformed
override fallback and external canonical exclusion. The runtime must preserve
the producer's canonical URLs; keep the `X-EmDash-Sitemap-Canonical` handshake
compatible with older active bundles during rollout. Release the shared
producer/consumer first, then rebuild the tenant and verify every public
sitemap destination against its emitted canonical. Update patch provenance
only when the patch bytes change.

The upstream endpoint, checked 2026-10-04, still builds
entry URLs from the collection pattern and does not apply the entry SEO
canonical. The deployed 1.1.0 patch remains required; no core upgrade or patch
removal is implied by that comparison.

Tedix adds only what Emdash does not emit:

- `tedix-seo-aeo` plugin: explicit site-owner identity (`identityType` is
  `Organization` by default, `Person` for personal sites), CollectionPage,
  BreadcrumbList, FAQPage, byline Person and `content-signal`. It enriches the
  native Emdash BlogPosting/WebSite builders under the native `primary` key,
  without emitting a competing Article graph. WebSite IDs and publisher
  references connect to the configured site owner.
- Locked discovery routes: `/llms.txt`, Markdown mirrors, `/rss.xml`.
- `tedix-tedi-bridge`: publish events into the organization tedi's memory.
- Public retrieval tools: `search_content`, `content_answer`.

Plugins derive public links from the collection `urlPattern`, never a hardcoded
`/posts/*`, so newsletters, breadcrumbs, JSON-LD, sitemaps, and RSS stay
correct under custom paths and reverse-proxy mounts.

Performance: routes read hydrated terms from `entry.data.terms` rather than
per-entry lookups; Emdash emits `rpc.count` in Server-Timing to separate
physical round trips from logical queries; `EMDASH_QUERY_LOG=1` adds query
metrics to logs during investigations.

## Deploy workflow

`cms_*.theme_deploy` is asynchronous; poll `theme_deploy_status({ jobId })`.

1. `preflight` materializes the starter, replaces editable files with the named
   `sourceCommit` from the tenant's Artifacts repo, restores locked files from
   `TEMPLATE_SNAPSHOTS`, and pins the editable-source digest.
2. `build-theme` creates a private workspace for each attempt, restores the
   exact commit again, and fails permanently if editable source differs from
   the preflight pin. It refreshes dependencies, applies locale and privacy
   banner config, and builds. The current Builder workspace is not the source
   for an Artifacts-backed deploy. Preparation must finish within five minutes
   before Astro starts; the Workflow step allows that preparation plus the
   Sandbox build lifetime, bounded control observations, and a safety margin.
   Progress history records the opaque build job ID. After an interrupted
   attempt, `theme_build_status({ jobId })` can show process state and a log
   tail only while Sandbox control responds and the process remains retained.
3. `snapshot-theme` stages the completed attempt's bundle in R2. If the build
   output disappeared after a Sandbox reset, this step rebuilds the pinned
   source in another private workspace before staging; its Workflow timeout
   covers the full rebuild and staging allowance. Each retry uses its own
   staging prefix so an abandoned process cannot overwrite the winning
   attempt. If the Sandbox control channel stops responding, wait for
   the Workflow to become terminal and reconcile the native build process and
   site restore permit before another deploy. Preserve the active editable
   source before any Builder sandbox reset.
4. `publish-bundle` writes the bundle and source identity to R2 and D1 and
   activates it. It rejects truncated commits and malformed digests.
5. `health-check` probes the live bundle and rolls back on failure.
6. `cleanup-staging` removes staged build inputs only after publish retries and
   the health check settle.

Build, preview, and exec use retained native v1 processes and return a `jobId`
with status and cancel tools (`theme_build_status`, `theme_build_cancel`,
`theme_preview_status`, `theme_preview_stop`). The preview process serves the
configured tenant preview hostname; it does not create SDK quick tunnels or
ephemeral provider URLs. All Site Builder lookups use the app-owned Durable
Object namespace in `apps/cms/src/sandbox.ts`; the Durable Object name is the
instance identity.

Scheduled publishing is not a deploy phase; it runs from the parent cron once a
bundle is active.

## Checks

These are targeted diagnostics, run after the relevant change.

| Change                                   | Check                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| Starter Emdash version or locked plugins | `cms:emdash-release:validate`, `cms:plugin-trust:validate`, `cms:templates:build` |
| DO adapter or Worker Loader binding      | `apps/cms-runtime` tests                                                          |
| Responsive images                        | `cms:responsive-media:validate`                                                   |
| Scheduler                                | `cms:scheduler:validate`                                                          |
| Studio MCP tools                         | A call through the affected tenant namespace                                      |

For a tenant bundle upgrade, verify the activated version, a representative
content read, and the public page. A Studio deploy or catalog sync cannot add
Emdash routes to already compiled bundles.

## Configuration reference

| Field                                      | Meaning                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `metadata.blogConfig.enabled`              | Enables CMS routing for the app                                                                        |
| `metadata.blogConfig.defaultLocale`        | Primary content locale                                                                                 |
| `metadata.blogConfig.authDescopeTenantId`  | Descope tenant for admin login; defaults to the owning organization's tenant                           |
| `metadata.blogConfig.privacyBannerEnabled` | Registers the privacy banner plugin only when explicitly true                                          |
| `cms_sites.custom_domain`                  | Active verified subdomain or zone-apex hostname from the claim flow                                    |
| `cms_sites.canonical_url`                  | Public origin used in canonical URLs, sitemaps, RSS, `/llms.txt`, mirrors, and `hreflang`; origin only |
| `cms_sites.public_path_prefix`             | Reverse-proxy mount path such as `/blog`; the runtime adapts stripped requests and prefixes links      |
| collection `urlPattern`                    | Native collection URL shape, for example `/posts/{slug}` or `/blog/{slug}` behind a proxy mount        |
| `metadata.branding`                        | Brand palette, fonts, and images injected as `PLATFORM_BRANDING`                                       |
| `metadata.socialLinks`                     | Injected as `PLATFORM_SOCIAL_LINKS`                                                                    |
| `metadata.seoConfig`                       | Platform SEO defaults such as search-engine verification                                               |
| native Emdash settings                     | Logo, favicon, default social image, robots; managed by `cms_*.settings_update`                        |

## Related

- [MCP runtime](../mcp/runtime.md)
- [Design system](../product/design.md)
- [Development](../DEVELOPMENT.md)

Canonical-aware native collection sitemaps declare `X-EmDash-Sitemap-Canonical: 1`. The edge preserves those URLs exactly, including per-entry trailing slashes; only older unmarked bundles retain the legacy theme-based slash rewrite.
