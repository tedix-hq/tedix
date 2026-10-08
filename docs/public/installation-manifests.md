---
sidebar:
  order: 140
title: "Installation manifests"
topic: "Getting started"
resource_type: guide
description: "Declare and certify a secret-free Tedix installation before provisioning begins."
summary: "Public reference for the versioned Tedix installation manifest"
read_when:
  - Describing a Cloudflare-native Tedix installation
  - Building installation preflight or provisioning tooling
visibility: public
---

# Installation manifests

> Self-hosting is experimental; see [Release status](./release-status.md).

`@tedix/installation-manifest` defines the versioned handoff from installation
planning to provisioning. It describes organization profile, Cloudflare account
and domain topology, Workers, routes, bindings, resources, provider
prerequisites, capabilities, lifecycle requirements, and sanitized bootstrap
inputs.

The manifest contains secret names only. Credentials remain in the operator's
secret provider and are injected after preflight. Runtime entitlements are
independent from optional billing settlement metadata.

`billingSettlement` is explicit deployment policy. An omitted block generates
`TEDIX_BILLING_SETTLEMENT_MODE=disabled`; configured `external` or `managed`
mode is emitted unchanged. Disabled and external overlays do not require Stripe
secrets. Managed Stripe settlement fails overlay generation unless the live and
test API-key and webhook-secret names are declared. The overlay also projects
the manifest's entitlement grants through the non-secret
`TEDIX_RUNTIME_ENTITLEMENT_GRANTS` JSON variable.

Managed settlement finds every Stripe price by lookup key; no Stripe product
or price id is stored in the installation. The Stripe account (live or test,
matching `TEDIX_STRIPE_MODE`) needs an active price for each key:

- plans: `tedix_growth_month_v3`, `tedix_growth_year_v3`,
  `tedix_business_month_v3`, `tedix_business_year_v3`,
  `tedix_enterprise_month_v3`, `tedix_enterprise_year_v3`;
- metered overage (growth and business): `tedix_token_overage_v3`;
- capacity packs: `tedix_inference_capacity_daily_1m_v1`,
  `tedix_inference_capacity_daily_5m_v1`,
  `tedix_inference_capacity_daily_10m_v1`,
  `tedix_inference_capacity_daily_25m_v1`,
  `tedix_inference_capacity_daily_50m_v1`.

`apps/api/scripts/billing/reconcile-stripe.ts --apply` creates the plan,
overage, and `daily_5m` prices.

`fleetAuthority.mode` is also required and is emitted as
`TEDIX_FLEET_AUTHORITY_MODE`. The sanitized developer/OSS manifest uses
`disabled` and requires no Stripe secret names. `co-located` requires the
worker's `DB` binding. No other mode is accepted.

Installation authority is also distinct from tenant and fleet authority.
Runtime entitlements stay in `tenant-product`; bootstrap, upgrade, backup,
restore, and installation-owner health are `installation-operations`; Stripe,
provider settlement, reconciliation, global catalog promotion, and
cross-installation administration are `fleet-commercial` (see
[Cloudflare architecture](./cloudflare-architecture.md#authority-boundaries)). An installation
manifest may supply coordinates for enabled planes; it does not merge their
authority or make commercial settlement a prerequisite for tenant entitlement
enforcement.

## Certification

Import `parseInstallationManifest` or `certifyInstallationManifest` from
`@tedix/installation-manifest/schema`. A document marked `certified` is rejected
when it has unresolved coordinates, unavailable required capabilities, a
profile/access-plan mismatch, missing required entitlements, or an unready
required provider. Issues are sorted deterministically for CI and automation.

The execution policy is fixed to `fail-before-mutation`: provisioning tools must
validate and certify the complete manifest before creating or changing any
resource. The package also exposes deterministic JSON Schema generation for
systems that do not execute TypeScript.

Use `@tedix/installation-manifest/developer-example` as a sanitized reference.
It uses example-only coordinates and contains no production installation IDs or
secret values. It is intentionally `uncertified` at the `schema-valid` level;
schema evidence is not clean-account or installation-ready certification.

## Account capability preflight

Import `preflightCloudflareAccount` from
`@tedix/installation-manifest/preflight` to verify a live Cloudflare account
before provisioning. The preflight is strictly read-only: it issues only GET
requests, and callers must refuse to provision when the returned
`mutationAllowed` is false. It checks that every declared account is reachable
with the supplied token, that each account exposes every product capability the
declared resources need (D1, R2, KV, Durable Objects, Workflows, Queues,
Workers, Browser Rendering, Workers AI, Vectorize, Hyperdrive, Containers,
assets), and that every declared zone exists, contains its declared hostname,
and belongs to its declared account.

Every manifest resource kind maps to exactly one probe; adding a resource kind
to the schema without deciding its probe fails compilation, so a required
dependency can never be silently omitted. Unresolved account or zone
coordinates fail the preflight without any network call. Optional-resource
capabilities that are missing are recorded but do not block.

For a disposable-account certification, set `freshAccount: true` on the target
account. The same read-only preflight then verifies that Worker scripts and
every declared resource inventory with a Cloudflare list endpoint are empty. A
non-empty inventory fails before provisioning, so an old alpha environment
cannot be misrepresented as a fresh-account result.

Run `bunx wrangler login` once using your own Cloudflare account. Then
`bun run --cwd packages/installation-manifest preflight --manifest <path>`
(`--json` for machine output) runs the same read-only check and exits non-zero
when a required capability is missing. The CLI reuses Wrangler authentication
through its supported `auth token --json` command; Tedix does not read
Wrangler's private credential files or store a second copy. An explicit
`CLOUDFLARE_API_TOKEN` takes precedence for automation. Global API key/email
authentication is not supported by these bearer-token installation tools.
The manifest, not the login, selects the target account. `--help` needs no
credentials and does not make network calls.

## Identity-provider readiness

An interactive Tedix OS also needs an operator-owned Descope project.
While evaluating, use a dedicated non-production project instead of
reusing a shared production identity project. This keeps test users, approved
origins, flows, keys, and later cleanup inside the installation being tested.

For interactive provisioning, declare `OS_URL`, `SESSION_BROKER_URL`,
`DESCOPE_BASE_URL`, and `DESCOPE_PROJECT_ID` in the manifest's OS Worker `vars`.
Declare one `apps/session-broker/wrangler.jsonc` Worker with those same four
values. `DESCOPE_BASE_URL` and `SESSION_BROKER_URL` must name the same auth
origin, distinct from `OS_URL`: Descope's bootstrap cookie and the broker's
refresh rotation share that host. URLs must be canonical HTTPS origins with no
ports, credentials, paths, queries, fragments, or trailing slash. Interactive
apply refuses missing, malformed, split, or ambiguous targets before provider
or Cloudflare requests.

Create a temporary, project-scoped management key with read access to project
configuration. `provision --apply` needs only `DESCOPE_MANAGEMENT_KEY` from the
environment for identity checks; the manifest supplies the target. For a
standalone diagnostic independent of provisioning, run:

```bash
DESCOPE_PROJECT_ID=your-project-id \
DESCOPE_MANAGEMENT_KEY=temporary-project-key \
TEDIX_OS_URL=https://os.example.workers.dev \
bun run --cwd packages/installation-manifest identity:preflight
```

The report lists the supplied OS hostname and its expected login URL:

| Surface  | Approved Web Domain      | Redirect URL                           |
| -------- | ------------------------ | -------------------------------------- |
| Tedix OS | `os.example.workers.dev` | `https://os.example.workers.dev/login` |

Approved Web Domains contain hostnames only — no scheme, path, or trailing
slash. The preflight checks the project's OIDC issuer, verifies the management
key by exporting project configuration, confirms every exact hostname, and
checks that the `sign-up-or-in` flow exists and is enabled. It also verifies
that the project-level `owner`, `admin`, `member`, and `viewer` roles grant
`tedis:read`, which an authenticated Tedix OS needs to load its workspace. Descope
exposes project export as an HTTP `POST`, but it is a read operation: Tedix does
not call project import, update, or key-management endpoints. Revoke the
temporary key after validation; treat diagnostic output as potentially
sensitive.

For a manifest that requires Descope plus Tedix OS, `provision --apply`
requires a passing identity report before the Cloudflare account preflight and
before any resource mutation. Plan mode remains read-only and does not require
identity credentials.

This is a configuration check, not deployed authentication certification. It
does not verify redirect registration, execute the login flow, or exercise
broker callbacks, cookies, tenant selection, session renewal, or logout.
Provisioning checks the manifest OS worker's declared configuration, not
deployed routes or browser build settings. Those must still agree with it.

The OS and broker runtime now consume those exact installation origins. The
browser build must receive the same values through its Wrangler overlay or
`TEDIX_BUILD_OS_URL` and `TEDIX_BUILD_SESSION_BROKER_URL`. The OS Worker serves
the exact launcher host; it does not infer tenant subdomains from a
`workers.dev` hostname. A passing provider report and source-level host tests
still do not prove independent login, tenant selection, session renewal, or
logout. Those need an operator-owned Descope custom auth domain, deployed
Workers, and live browser proof on the installation's endpoints. `workersDev`
controls Worker exposure only; it is not an authentication setup switch.

## Deployment profiles

`@tedix/installation-manifest/profiles` defines what each supported profile —
`developer`, `smb`, `enterprise` — must declare before it can be certified
`profile-ready`. Requirements are additive: SMB includes developer plus an
operator UI surface (Tedix OS), a required queue, and lifecycle
backup; enterprise includes SMB plus required browser capability and governed
workstation containers, and a mandatory restore test. Every profile requires
the identity provider prerequisite and lifecycle export — customer-owned data
contracts are part of the product promise, not an upsell.

`certifyProfileReadiness(manifest)` checks a manifest against its declared
profile and returns deterministic, sorted issues; this is what the
`profile-ready` certification level means before any live-account proof. The
sanitized developer example passes for `developer` and reports exactly the
missing surfaces and requirement upgrades when re-declared as a higher
profile.

## Resource provisioning

Import `provisionCloudflareResources` from
`@tedix/installation-manifest/provision` to materialize the manifest's
account-level resources. It runs the capability preflight first and refuses to
act when that fails, honoring `fail-before-mutation`. The default `plan` mode
stays strictly read-only and reports the action an apply run would take per
resource; `apply` creates missing resources idempotently and adopts existing
ones instead of recreating them, resolving unresolved coordinates from the
created ids.

Every resource kind has exactly one compile-time-checked provisioning path:
D1, R2, KV, Queues, and Vectorize are API-creatable; Durable Objects,
Workflows, services, assets, and containers are deploy-owned (materialized by
deploying the declaring Workers, reported but untouched); Browser Rendering
and Workers AI are account capabilities proven by the preflight; Hyperdrive
requires operator-held origin credentials and is only verified.

`executeD1Statements` runs ordered SQL against a provisioned D1 database over
the REST API, stopping at the first failure — the sanctioned path for
migrations and sanitized seed data, whose SQL always comes from the caller's
tracked files, never from this package. `bootstrapPlan` derives the sanitized
seed profile, secret-free bootstrap inputs, and target D1 resources from the
manifest.

`bun run --cwd packages/installation-manifest provision --manifest <path>`
uses the same Wrangler login or explicit API token and prints the plan;
mutation requires the explicit `--apply` flag, and `--json` emits the
machine-readable report. Interactive apply reads only `DESCOPE_MANAGEMENT_KEY`
for the identity check above. The former `--os-url`, `--descope-base-url`, and
`--descope-management-api-base` provisioning flags are removed; target settings
belong in the manifest, not parallel command-line or environment overrides.
Provisioning creates resources, not a complete running installation; it does
not deploy Workers or replace the remaining bootstrap and identity setup.

## Backup, restore, and upgrade

`@tedix/installation-manifest/lifecycle` implements the manifest's lifecycle
promises against a live account: `exportD1Database` (the polling export
protocol, returning the SQL dump), `restoreD1Database` (statement-split
restore through the same caller-supplied-SQL path the bootstrap uses),
`verifyD1Restore` (per-table row-count diff enumerated from the source
schema, so a missing table fails instead of narrowing the check),
`r2BackupRoundtrip` (write → copy under a backup prefix → byte-compare), and
`applyD1Upgrade` (migration statements plus a schema verification against a
restored database — recovery must accept the next upgrade, not just serve
reads). All network access is injectable; tests never leave the process.

## Wrangler overlays

Each worker declares a workspace-relative authored `sourceConfig` and its
installation-specific non-secret `vars`. Import `createWranglerOverlay` from
`@tedix/installation-manifest/wrangler-overlay` to combine that manifest with
the authored Wrangler JSONC for one worker and installation environment.

`workersDev` is an explicit per-worker installation decision. The overlay
discards an authored `workers_dev` setting and uses the manifest value, so a
fresh-account rehearsal can intentionally expose a worker at its account's
`<subdomain>.workers.dev` hostname without requiring a DNS zone. Set it to
`false` for a custom-domain-only worker.

The generator strips authored `env` branches and all source account, worker,
route, var, secret, binding, and resource coordinates before applying the
manifest. It preserves non-coordinate runtime structure, including `main`,
compatibility flags, observability, placement, triggers, and Durable Object
migrations. Output is deterministic Wrangler-compatible JSON; required secret
names are returned separately and secret values are never emitted.

Preview mode permits an uncertified schema-valid manifest but rejects unresolved
coordinates. Deploy mode requires a successfully certified manifest at
`installation-ready` or `operational`. The tracked
`apps/api/wrangler.oss-example.json` and matching `.secrets.json` name artifact
are regenerated with `bun run installation-manifest:overlay`; CI enforces drift
with `bun run installation-manifest:overlay:check`.

These generated files are sanitized examples, not deployment or clean-account
certification. Managed production coordinates are never published: every
checked-in `wrangler.jsonc` is an example with placeholders instead of account,
zone, or resource identifiers, and the private operations repository holds the
live configuration. See [Release status](./release-status.md).
