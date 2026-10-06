# @tedix/installation-manifest

Secret-free, versioned installation declarations for Cloudflare-native Tedix deployments.

## Overview

This package defines the Apache-2.0 ecosystem contract between
installation planning and mutation. It describes installation identity,
organization profile, Cloudflare topology, runtime resources, provider
prerequisites, capability access, lifecycle requirements, and certification
without carrying credentials or billing-provider authority.

Import the direct subpaths; the package intentionally has no root barrel.

## Usage

```typescript
import { developerInstallationManifest } from "@tedix/installation-manifest/developer-example";
import {
	certifyInstallationManifest,
	parseInstallationManifest,
} from "@tedix/installation-manifest/schema";
import { createWranglerOverlay } from "@tedix/installation-manifest/wrangler-overlay";

const preflight = certifyInstallationManifest(developerInstallationManifest);
if (!preflight.success) {
	throw new Error(preflight.issues.map((issue) => issue.code).join(", "));
}

const manifest = parseInstallationManifest(developerInstallationManifest);
const overlay = createWranglerOverlay({
	manifest,
	sourceConfig: authoredWranglerJsonc,
	workerId: "control-api",
});
```

The developer example is intentionally `uncertified` at the `schema-valid`
level. Schema evidence demonstrates a sanitized valid document; clean-account
or installation-ready certification requires separate deployment evidence.

For a disposable-account certification, set `freshAccount: true` on the target
Cloudflare account. The read-only preflight then requires its Worker-script
inventory and every declared API-creatable resource inventory to be empty. It
refuses provisioning when it finds prior resources, preventing an old alpha
environment from being relabeled as fresh-account proof.

`parseInstallationManifest()` rejects unknown fields, secret-value fields,
secret-provider references, unresolved coordinates on a certified document,
and profile/capability violations. Installers must complete this parse before
mutation; the manifest fixes `execution.preflight` to `fail-before-mutation`.

Each worker names a workspace-relative authored `sourceConfig` and its
installation-specific, non-secret `vars`. `createWranglerOverlay()` removes
authored accounts, names, routes, environment branches, vars, secrets, and
resource bindings before applying manifest coordinates. It preserves authored
engine configuration such as `main`, compatibility flags, observability,
placement, and Durable Object migrations. The result includes deterministic
Wrangler JSON text plus a separate sorted list of required secret names; it
never includes secret values.

Each worker must also declare `workersDev`. The overlay discards any authored
`workers_dev` value and writes this manifest-owned setting instead. Set it to
`true` for a zero-DNS validation on the account's `<subdomain>.workers.dev`
hostname; set it to `false` when the installation deliberately exposes that
worker only through manifest-declared custom domains or routes.

Preview mode accepts a schema-valid uncertified manifest but still rejects every
unresolved coordinate. Deploy mode additionally requires successful
`certified` validation at `installation-ready` or `operational`. Generate or
check the tracked developer artifacts from the repository root with
`bun run installation-manifest:overlay` or
`bun run installation-manifest:overlay:check`.

The `preflight` and `provision` commands reuse your own `bunx wrangler login`
through Wrangler's supported `auth token --json` interface. An explicit
`CLOUDFLARE_API_TOKEN` takes precedence for automation; global API key/email
credentials are not supported. No Tedix Cloud account is required, and the
tools do not persist or print credentials. The manifest
selects the target account. Both commands support credential-free `--help`.
Provisioning defaults to a read-only plan; `--apply` creates resources but
does not deploy the complete product.

For interactive OS provisioning, declare `OS_URL`, `SESSION_BROKER_URL`,
`DESCOPE_BASE_URL`, and `DESCOPE_PROJECT_ID` in the manifest's OS worker `vars`
and in one `apps/session-broker/wrangler.jsonc` worker. The broker and Descope
origins must match and differ from the OS origin. URL values must be canonical
HTTPS origins without ports, credentials, paths, queries, or fragments.
The provisioning path supports one OS worker and one broker worker; several OS
surfaces may reference that same OS worker. Missing or split targets fail
before provider or Cloudflare requests. Supply only `DESCOPE_MANAGEMENT_KEY` externally;
provisioning does not accept separate identity-target flags or environment
overrides.

The standalone read-only diagnostic remains available for checking provider
configuration independently of a manifest:

```bash
DESCOPE_PROJECT_ID=your-project-id \
DESCOPE_MANAGEMENT_KEY=temporary-project-key \
TEDIX_OS_URL=https://os.example.workers.dev \
bun run --cwd packages/installation-manifest identity:preflight
```

The gate checks the OIDC issuer, management access, exact Approved Web Domains,
enabled sign-in flow metadata, and tenant-role permissions using Descope's
read-only project export. It reports the expected `/login` URL but does not
verify redirect registration or execute a login. Interactive `provision --apply`
refuses before any Cloudflare mutation when this configuration check is absent
or fails. Treat diagnostic output as potentially sensitive.

A passing report is not proof of a working self-hosted installation.
Provisioning checks declared origins and provider configuration, not deployed
routes or browser build output. The OS and broker runtime consume the declared
origins; build the OS browser bundle with the same `OS_URL` and
`SESSION_BROKER_URL` values. Independent login, tenant selection, session
renewal, and logout still require an operator-owned Descope custom auth domain,
deployed Workers, and live browser evaluation. The standalone
`TEDIX_OS_URL` diagnostic input does not configure runtime paths.

## Exports

| Import                                            | Purpose                                                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `@tedix/installation-manifest/developer-example`  | Sanitized developer-profile example with representative Cloudflare resources and bindings                      |
| `@tedix/installation-manifest/identity-readiness` | Read-only Descope issuer, project export, flow metadata, domain, and role checks                               |
| `@tedix/installation-manifest/lifecycle`          | D1 export, restore, restore verification, and upgrades; R2 backup roundtrip with writes                        |
| `@tedix/installation-manifest/preflight`          | Read-only Cloudflare account, resource inventory, and capability checks                                        |
| `@tedix/installation-manifest/profiles`           | Deployment-profile requirements and deterministic readiness checks                                             |
| `@tedix/installation-manifest/provision`          | Read-only resource plans, explicit resource creation, caller-supplied D1 SQL execution, and bootstrap planning |
| `@tedix/installation-manifest/schema`             | Zod schema, inferred types, deterministic certification, parser, and JSON Schema generation                    |
| `@tedix/installation-manifest/wrangler-overlay`   | Deterministic, secret-free Wrangler overlay generation and secret-name artifact rendering                      |

Entitlements are runtime grants. `billingSettlement` is a separate optional
record and is not required to certify an installation.

The generated developer Wrangler file is a sanitized preview artifact, not
proof of a working deployment.

See the public
[installation manifest reference](../../docs/public/installation-manifests.md).
