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

## Bindings

- `LOADER` (worker_loaders) — Dynamic Worker isolate factory
- `DB_DO` (durable_objects) — Emdash Durable Object SQLite namespace
- `TENANT_BUNDLES` (R2) — per-tenant bundle blobs
- `PLATFORM_DB` (D1, read-only) — slug → org + active bundle lookup
- `SESSION` (KV) — shared session storage (per-tenant prefixed)
- `CMS_SESSION_BROKER` (Service Binding, production) — named auth-host broker
  entrypoint used by `dual`/`on` session modes
- `CF_ACCOUNT_ID` (var)
- `CLOUDFLARE_R2_API_TOKEN` (secret) — tenant media R2 REST access

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
