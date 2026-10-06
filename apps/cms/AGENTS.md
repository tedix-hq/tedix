---
summary: "apps/cms scoped rules: the generated template snapshot, locked-vs-editable theme policy, D1 batch activation, internal proxy auth, and the Docker-bound deploy lane"
read_when:
  - Touching anything under apps/cms/ (Site Builder Worker or templates/)
  - Editing src/agent/constraints.ts or anything under templates/
  - Changing CMS auth, the cms-runtime proxy, or the deploy pipeline
title: "apps/cms agent guide"
---

# apps/cms Agent Guide

Root rules live in `/AGENTS.md`. This is the Site Builder Worker
for the Emdash CMS. Start with `apps/cms/README.md`
and the relevant template or runtime module.

## The template snapshot is generated

`src/template-snapshot.ts` is **generated** by
`scripts/generate-template-snapshot.ts` from the installed scaffolds in
`CMS_TEMPLATE_SLUGS` (`src/template-policy.ts`).
Never hand-edit it. Edit `templates/` and explicitly run
`bun run snapshot:template`. Both `type-check` and `deploy:production` run
`snapshot:check`, so a stale committed snapshot fails before CI or a production
deploy can silently regenerate different source.

## Template policy has one source

The dependency-free `src/template-policy.ts` declares template slugs and
locked/editable paths. Runtime constraints and snapshot generation both import
it. Update that manifest, then regenerate the snapshot; do not add mirrored
policy lists to either consumer.

## Homepage publication policy

The landing plugin reads its native `policy` setting
(`plugin:tedix-homepage-policy:settings:policy`). It selects collection and
page slugs, then checks only dependencies imposed by the theme renderer.
Native block schemas own field values and version rules. Changing starter
seed JSON does not change a live site's schema or settings.

Historical revision restoration can stage data without the normal content-write
validation. Preserve the renderer dependency check for restored drafts; do not
claim that this hook revalidates the whole native schema.

## Plugin conventions (Emdash)

- Locked plugins exporting an **id-less** `{ routes }` / `{ hooks }` object
  use Emdash's sandbox-format two-argument `(routeCtx, pluginCtx)` convention.
  Adding an `id` changes the handler convention; convert handlers together.
  `tedix-editor-actions` uses `definePlugin` with an `id` and the native
  single-argument route context. Preserve that convention. Its shared
  `metadata.ts` supplies editor extensions and allowed hosts to both Astro
  descriptors: standard plugin registration reads these declarations from the
  descriptor, not the entrypoint's default export.
- `templates/tedix/src/plugins/*` and `templates/tedix/src/lib/platform-rpc.ts`
  are the plugin source — edit them in place, then `bun run snapshot:template`.
  Their tests live in `src/template-plugins.test.ts`, which also puts them under
  the app's `tsc` (hence the `emdash` / `@orpc/client` devDependencies).
- Hook handlers declare `errorPolicy: "continue"` and never throw
  — a publish must not fail because a side-effect hook did.

## D1: activation is a batch

Bundle activation/rollback flips `is_active` across rows atomically with
`db.batch()`, never a transaction (root D1 rule):
`activateTenantBundleVersion` (`packages/provisioning/src/cms.ts:353`) and
`rollbackCmsTenantBundle` (`src/agent/storage.ts:112`). Keep any new
multi-statement bundle mutation in that shape.

## Auth boundaries

- **Site Builder → cms-runtime proxy:** the trusted service-binding path sends
  `X-Tedix-CMS-Internal-Auth`, never a non-Emdash `Authorization` bearer —
  Emdash's bearer middleware rejects unknown token formats before the external
  auth provider can run (`src/agent/cms-proxy-runtime.ts`).
- **Tenant membership cache** (`isUserMemberOfTenant`, `src/index.ts:162`): a
  `null` from Descope means "couldn't determine" — fail closed and do **not**
  cache it, so the next request retries. The cache is bounded; keep it that
  way.
- **No per-tenant `cms:<slug>` Descope scopes** (`src/index.ts` header at
  ~line 218): the AIH policy registry is Console-only, so per-tenant scopes
  need manual clicks per customer and do not scale. Tenant authorization is
  runtime membership resolution.

## Sandbox builds

The build session env stays **explicitly enumerated** — exactly
`{ ORG_SLUG, PRIVACY_BANNER_ENABLED, PUBLIC_SITE_URL, PUBLIC_PATH_PREFIX }`
(`src/agent/build-runner.ts`). The public route comes from the active
`cms_sites` row and is validated before the build starts.
Never pass the Worker env or a secret-injected environment into a tenant Astro build:
build-time secrets get statically inlined into the shipped bundle (emdash
#2140, the `import.meta.env` secrets-inlining class).

## Deploys need Docker

`cloudflare.config.ts` defines the `SiteBuilderSandboxRuntime` container, so
`vp build` builds its image with Docker. A machine without Docker cannot build
or deploy cms. Managed deployment runs through the guarded workflow in
`tedix-hq/tedix-cloud-ops`, not an app-local deploy command.

Two config rules fail without an error at review time:

- `SiteBuilderSandboxRuntime` is the only builder namespace. Its workspace is
  disposable: canonical tenant source lives in Artifacts and is materialized
  into the native Sandbox v1 container before builds and deploys.
- Every live Worker secret is a `bindings.secret()`. `cf deploy` deletes any
  secret the config does not declare.

## Verification

`bun run type-check` (includes `snapshot:check` and `cf workers types`) and
`bun run test:run`.
For plugin or template changes, also run root `cms:plugin-trust:validate`
and `bun apps/cms/scripts/build-templates.ts` from the repository root.
