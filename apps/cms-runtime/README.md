# @tedix/cms-runtime

Cloudflare Worker that hosts the multi-tenant CMS using Dynamic Workers
(`worker_loader` binding).

## What it does

1. Maps `{slug}` under the installation's configured CMS domain
   to an org row in the platform D1.
2. Looks up the active bundle row in `tenant_bundles` for that slug.
3. Pulls the Astro+Emdash bundle (main + chunked modules) from R2
   through `TENANT_BUNDLES`, keyed by `{slug}/v{version}/...`.
4. Spawns a per-tenant V8 isolate via `env.LOADER.get(slug@version, factory)`.
5. Injects a `DB_DO` EmDashDB RPC stub plus per-tenant
   `R2Bucket`-shaped (`TenantR2`) and session (`TenantSession`) RPC stubs as
   the isolate's `env.DB_DO`, `env.MEDIA`, and `env.SESSION`.
6. Forwards the request to the isolate's default entrypoint.

## Database And RPC Stubs

The tenant bundle uses Tedix's Worker-Loader-safe Emdash `durableObjects()`
descriptor with `binding: "DB_DO"` and a build-stamped `name` equal to the org
slug. `apps/cms-runtime` owns the `EmDashDB` class and injects a serializable
`TenantEmDashDB` RPC stub through Worker Loader. The stub exposes direct
`query`/`batchQuery` methods and the collection deletion guard for tenant
bundles. The guard runs in the owning EmDashDB Durable Object so its lease,
capture fence, and table drop share one database boundary.

Dynamic Workers still cannot receive native R2 or DurableObjectNamespace
bindings via the factory `env`, so media remains a `WorkerEntrypoint` RPC stub
and `DB_DO` is exposed as the serializable `TenantEmDashDB` RPC stub. Every
active tenant's content lives in its slug-named EmDashDB object; the runtime no
longer reads or injects the legacy per-tenant D1 databases.

`/_tedix/internal/database-runtime` is the protected database diagnostic
endpoint. It requires `X-Tedix-CMS-Internal-Auth: $CMS_INTERNAL_AUTH_TOKEN` or
`Authorization: Bearer $CMS_INTERNAL_AUTH_TOKEN`. `GET` scans the active R2
bundle's compiled Emdash config and reports `activeBundle.databaseAdapter`;
handoff requires `durableObjects`, not merely a source starter that has already
been upgraded.

## Registry editor contributions

The parent plugin host supports one declarative JSON field widget per registry
manifest. This is source support for the existing restricted plugin-host lane,
not permission to enable the host for more sites or deploy tenant bundles.
The manifest path is `admin.fieldWidgets`:

```json
{
	"admin": {
		"fieldWidgets": [
			{
				"name": "caption",
				"label": "Caption details",
				"fieldTypes": ["json"],
				"elements": [
					{
						"type": "text_input",
						"action_id": "caption",
						"label": "Caption",
						"placeholder": "Enter caption"
					}
				]
			}
		]
	}
}
```

This is an excerpt from an otherwise supported bundle: it still needs the
`plugin:install` hook, backend code, zero host capabilities and no allowed
network hosts. Installation validates the raw contribution before persistence;
execution revalidates the active tenant's canonical bundle. Active registry
metadata reaches EmDash's generic editor renderer without an admin script.
A JSON collection field selects it with `widget: "pluginId:caption"`. Each
`action_id` edits one property of that field's object, preserving its siblings.
The normal content editor owns draft saving and publication; rendering the
widget makes no plugin RPC.

Widget names are lowercase letters, digits and hyphens, starting with a letter
(at most 64 characters). A widget has 1–8 text inputs with unique lowercase
`action_id` keys (letters, digits and underscores, starting with a letter,
at most 64 characters; `constructor` and `prototype` are rejected). Labels
are nonblank and at most 128 characters; optional placeholders are nonblank
and at most 256. Unknown widget or element keys, other field/element types,
custom admin entrypoints, settings, pages, dashboard widgets, editor actions
and panels remain rejected. Empty `pages` and `widgets` arrays remain valid.
Disabled registry plugins do not publish field widgets.

Block Kit is the declarative authoring UI here, not a content block format.
Portable Text objects use `_type` in rich-text content and are not admitted
by this subset. Native versioned blocks use EmDash's separate block registry
and retain their existing schema/version rules. None of these editor declarations
adds a public-site renderer: public rendering remains an explicit native theme
concern.

## Bindings

- `LOADER` (worker_loaders) — Dynamic Worker isolate factory
- `DB_DO` (durable_objects) — Emdash Durable Object SQLite namespace
- `TENANT_BUNDLES` (R2) — per-tenant bundle blobs
- `PLATFORM_DB` (D1) — site and bundle lookup, restore admission and permits
- `SESSION` (KV) — shared session storage (per-tenant prefixed)
- `CMS_SESSION_BROKER` (Service Binding, production) — named auth-host broker
  entrypoint used by `dual`/`on` session modes
- `CF_ACCOUNT_ID` (var)
- `CLOUDFLARE_R2_API_TOKEN` (secret) — tenant media R2 REST access

## Public restore reservations

GET/HEAD response creation and body pulls share a D1 reservation within one
serving isolate for ten seconds. Creating a reservation checks the site's status,
epoch, restore fence and deprovision reservation. Reuse performs no D1 check.
The durable reservation uses the nested kind, so restore reconciliation cannot
reclaim it as an abandoned outer response. The reuse window expires even under
continuous traffic; active renders retain the row until their last borrower
finishes. The last borrower of an expired reservation awaits its deletion.
Idle cleanup normally runs in `waitUntil`, backed by a durable renewable lease.
Leased claims use `lease:v1:runtime:<owner-id>:<uuid>` IDs. Their `entered_at`
value records the most recent successful lease grant, not the first admission.
A live borrower renews every twenty seconds. If renewal fails or stalls, its
Worker execution (or database object) is aborted after sixty seconds of local
authority, before D1 permits reclamation after 120 seconds. A delayed renewal
cannot revive an expired or deleted claim. Ending a borrower stops its renewal;
other borrowers keep their own execution contexts and renewal tasks.

Public requests, cron and restore/deprovision drain reads sweep expired leases
through the same bounded D1 query. Lost idle cleanup and isolate loss therefore
do not depend on an operator writing an R2 retirement receipt. Each sweep
removes at most 1,000 rows. The build owner remains diagnostic metadata;
`/health/` reports it as `runtimePermitOwnerId`.

Legacy runtime rows entered before 21 November 2026 at 06:00:00 UTC become
eligible for the same sweep on 22 November at 06:00:00 UTC. This is a one-time
rollout retirement assumption accepted by the installation owner, not a
platform limit on HTTP or Durable Object calls. Sites with an unfinished
deprovision operation (including failed operations), restore fence or capture
pause are skipped until those records are reconciled. The sweep logs counts
by kind and up to 1,000 skipped site IDs; cron reports skips even when nothing
is removed.

Database media-bucket operations, recovery purges and CMS agent operations use
`admin:media-bucket:`, `admin:recovery-purge:` and `admin:cms-agent:` IDs. These
claims retain their explicit completion contract, including uncertain provider
or process outcomes; neither expiry nor legacy retirement reclaims them.
The runtime does not accept an operator-authored retirement file.

An idle request sweep costs one DELETE with a bounded SELECT subquery per
serving isolate at most every ten seconds, and zero statements between sweeps
or without traffic. A sweep that removes rows, or a forced cron sweep, also
issues one SELECT for skipped sites. Errors reset the request throttle.
An uncertain INSERT is released before tenant work begins. Scheduled handlers
acknowledge completion after their handler and tracked background work drain,
before returning the final RPC response. A transport failure aborts the owning
execution before its lease can expire.

Bundle retention runs directly inside a cron
invocation (15-minute platform wall-clock limit). Only its scheduled permits
are reclaimed after one hour, before publication and by the hourly cron sweep.

Only admission is shared: authentication and the response handler still run for
each request, including authenticated reads. Every body pull borrows a reservation
in the pinned epoch and retains it through completion or cancellation.
SQL statements and batches share a separate nested reservation in the site's
existing database Durable Object. Replicas forward these operations to the
primary, which coordinates callers across serving isolates and returns its
current bookmark. This can add latency for readers far from the primary.
Admission is serialized so simultaneous cold callers share the first published
reservation; SQL execution remains outside that admission lock.
Restore reconciliation cannot reclaim the nested row as an abandoned outer
response. Every SQL operation borrows admission and holds a borrower until its
actual RPC finishes, even when the caller times out. SQL mutations and storage
callbacks check the current epoch, site status and fences through a primary D1
write before dispatch, including when their reservation is cached. Plain SELECTs
and read-only batches retain shared admission. Epoch closure runs in the owning
database object, refuses new mutating calls and awaits its actual executing
write callbacks before closing D1. This prevents a delayed provider dispatch
from crossing the epoch close; permit rows do not participate in that step.
The restore workflow waits only for administrative claims (`admin:` IDs),
including unknown provider outcomes outside this coordinator. Runtime and
scheduled leftovers do not block restore. After verifying the restore, the
workflow removes old-epoch runtime permits under its exact fence before
releasing it. Only plain SELECTs are retried; writes execute once.
Tenant R2 and session writes, the collection
deletion guard and tenant egress borrow the same nested reservation through
the database object: the operation runs in the caller, and the object holds its
borrower until the caller's callback settles or disconnects. Plugin KV, AI Search
and contact-form work also use this shared admission. Scheduled bundle retention
holds the same coordinator through its R2 and catalog writes. Plugin KV writes and
collection deletion additionally check the pinned epoch inside the database
RPC that performs the mutation. Scheduled runs keep exact
per-operation permits.

Recovery capture pauses new scheduled admission without waiting for existing
permits or requiring completion receipts. It retains the SQL and media checks
that refuse publication when captured content changes during verification.
Releasing or aborting the exact capture pause also clears scheduled leftovers;
it preserves administrative claims and runtime reservations for human edits.
No database migration or new namespace is required.
Tenant Worker Loader keys include the runtime release
so a deployment refreshes injected database RPC methods. The installation's D1
analytics must establish the actual reduction after release.

## Deploy

Releases of the shared serving Worker follow the installation's release
procedure. Deploying it does not provision a tenant website.
For the invited Cloud editorial path and prerequisites, see the
[CMS guide](../../docs/public/cms.md).

## Public-checkout validation

```sh
cd apps/cms-runtime
bun run type-check
bun run test:run
bun run build
```

`cloudflare.config.ts` declares the Worker; `bun run type-check` regenerates
its binding types with `cf workers types`. `bun run dev` serves it with Vite
using only local D1/R2/KV/DO state; it requires no Cloudflare account or secret
provider. Capabilities without a local implementation (AI Search, the API and
session-broker services) are omitted and fail closed.

## Limitations

- `TenantR2` implements only the `R2Bucket` methods Astro and Emdash use. A
  tenant bundle that calls another method, such as
  `R2Bucket.createMultipartUpload`, fails at runtime.
- The session driver prefixes keys by tenant slug in one shared KV namespace;
  it does not isolate sessions per organization beyond that prefix.
