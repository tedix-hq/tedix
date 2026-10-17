---
summary: "Organization model-egress residency policy, regional provider catalog and remaining migration boundaries"
read_when:
  - Designing organization data residency or provider region enforcement
  - Auditing model routing for regional data processing
---

# Organization data residency

Phase 1 adds an organization model-egress setting and a versioned provider
catalog. A missing policy row preserves existing routing. An explicit `eu`
row requires a verified regional route or stops the model request with an
administrator action. No organization is enabled by the migration.

This setting does not migrate storage, change bindings, move identity or
connected tools, or certify end-to-end EU residency. The private operator
runbook owns installation inventory, provider attestation and migration steps.

An organization owner should be able to require EU processing without choosing
a different model for every tedi. A missing eligible credential must stop the
request before any prompt, attachment, embedding, audio, or tool result leaves
the policy boundary. Other organizations retain their current behavior.

## Phase 1 routing and activation

Owners/admins read `organizations.getDataResidency` and update with
`organizations.setDataResidency({ mode, expectedRevision })` in their selected
organization. Revision zero means no row. Updates use a conditional revision
check and an atomic audit receipt. Tenant administrators cannot publish
geography claims: `organizations.publishResidencyProviderVersion` and
`organizations.listResidencyProviderCatalog` require platform authority.

Provider rows pin the model, API kind, transport, gateway identity, regional
resource and origin, supported text/image modalities, credential reference,
processing evidence and expiry. Publish a later version of the same member
with `enabled: false` to revoke it. Regional routing preserves the selected
model and existing budget/model permissions; it may only replace its resource
with a verified EU resource. Auto Router and unknown geography are ineligible.

Both the kernel and native tedi transports obtain authoritative policy before
budget admission and recheck before returning dispatch authority. EU requests
use the selected organization's encrypted provider key, disable gateway logs
and cache, reject redirects and have a short send window. Execution evidence
records policy/pool revisions and references, never the credential value.

Auxiliary learning, speech, CMS generation, OCR and content-embedding paths
without a regional adapter are blocked for restricted organizations. Drain
pre-existing live voice connections and asynchronous indexing work before
activation: this setting cannot recall bytes already sent or relocate a
provider session that is already open. Storage and connected-provider policy
remain separate work.

For a first Azure pilot, supply the API key for an explicitly **regional EU**
Azure OpenAI resource in organization encrypted secrets. Use the catalog row's
exact `credentialRef` (for example `AZURE_OPENAI_EU_API_KEY`), not a new Worker
binding. Supply its origin, resource/deployment names, supported modalities,
regional deployment SKU/location and current retention/processing evidence
covering the intermediary gateway too. A Global deployment or an EU-looking
hostname alone is insufficient. No live provider pool is seeded by source.

## Remaining installation boundaries

The presentation model catalog reports its default as deployment-scoped
(`apps/api/src/services/model-catalog-projection.ts`). Runtime profiles and tedi
overrides add further choices. Kernel, operator, observer, cron, judging,
voice, embeddings, learning jobs, CMS generation, and direct Workers AI calls
have separate execution paths. A filter in the chat selector alone would
misrepresent enforcement. EU endpoint credentials, model availability, regional
gateway processing/logging and fallback behavior need verified evidence first.
Phase 0 established the design and test plan. Phase 1 adds routing enforcement
and denies unsupported auxiliary paths; installation activation still needs
verified provider evidence and a separate operator decision.

## Persistence and contracts

Add `organization_residency_policies` through the normal Drizzle migration
workflow. Its primary key and foreign key are `organization_id`; fields are
`mode` (`unrestricted` or `eu`), `revision` (positive integer), `updated_at`,
and the authenticated updater's principal reference. Missing row means the
existing unrestricted behavior. Do not backfill, enable EU, or rewrite an
existing runtime profile during rollout. An explicit EU row is a restriction,
not proof that storage, identity, or external tools have moved.

Use a separate versioned provider-pool asset stored in D1, with members carrying
provider/model identifiers, endpoint origin, processing jurisdiction, supported
modalities, credential reference, evidence reference, expiry, enabled status,
and cost/budget eligibility. Credentials stay in the existing encrypted secret
store. Neither organizations nor provider-region claims belong in TypeScript
allowlists. Match exact normalized origins; a model name or an endpoint suffix
alone is insufficient evidence of processing region. Account for global versus
regional deployment SKUs and provider abuse-monitoring/storage exceptions.

Put public schemas and contracts in `packages/api-contract/src/schemas/` and
`contracts/`, using direct imports. Organization and pool reads/writes belong in
owning `@tedix/db/queries/<domain>` modules; routers never issue inline Drizzle.
Use `db.batch()` for a policy update plus audit receipt, with revision CAS.
Use unique output column names in every join, including batched reads.

Only an authenticated organization owner/admin may set the policy, within the
selected organization. Fail a restricted request if its authoritative policy
cannot be read; do not downgrade an EU row using cache/fallback. Cache keys must
include organization and revision; queued work revalidates at send time.
Provider pool management has separate platform/operator authority and must not
be writable by a tenant choosing its own residency constraint.

## Routing contract

1. Derive the organization from authenticated request/Work context. Read the
   authoritative residency policy before selecting or authorizing a provider.
2. Preserve existing selectors for absent/unrestricted policy. For `eu`,
   intersect existing model/modality permissions, budget, credentials and
   health with the enabled, unexpired EU provider pool. Never widen a tedi's
   model policy or automatically buy capacity to satisfy residency.
3. Apply the restriction to explicit model refs, dynamic routes, retries,
   fallback, observers, tools invoking models, embeddings, speech and image
   paths. Unknown geography is ineligible. Auto Router is eligible only when
   every possible downstream route and its processing/logging boundary is
   verified EU. Otherwise reject it before sending.
4. Resolve an eligible credential by reference through the existing secret
   service. If absent, return a typed `EU_PROVIDER_CREDENTIAL_REQUIRED` error
   listing the exact pool member credential reference and modalities blocked.
   Do not expose another tenant's secret names or probe credential values.
5. Recheck organization, policy revision and provider identity at the existing
   execution authorization boundary. Record policy revision, pool revision,
   provider origin, jurisdiction evidence and credential reference (no value)
   with the execution receipt. Check the actual final provider on adaptive
   routes; a mismatch stops subsequent sends and records a residency violation.

For a proposed Azure EU member, choose a **regional** EU deployment, not a
Global deployment. The operator must supply an API credential for that exact
resource, its endpoint origin, deployment name, regional SKU/location proof,
modalities and retention/processing terms. A proposed secret name such as
`AZURE_OPENAI_EU_API_KEY` is a future pool reference, not an existing supported
runtime environment variable. The error must use the actual approved row's
reference. If no EU member is configured, return `EU_PROVIDER_POOL_REQUIRED`
with the missing provider evidence/configuration instead of inventing a key.

Cloudflare routing through an EU storage resource does not regionalize inference,
TLS, Worker execution, gateway logs, identity or connected providers. This setting
initially enforces model egress only. Product wording must say that scope.

## Jurisdiction-aware Durable Object design

Use a separate, explicit organization/object migration map for DO addressing;
model residency alone must not change a DO id. Addressing inputs must include
both logical key and recorded jurisdiction. A shared helper selects
`namespace.jurisdiction("eu")` **before** `idFromName` or `getByName`, and must
pass that same selected namespace to `get`, all RPC callers, retries, callbacks,
and self-identity assertions. Never feed a global id into an EU namespace or
assume that the same logical name resolves to the old state.

```ts
function objectNamespace<T extends DurableObjectNamespace>(
	namespace: T,
	jurisdiction: "global" | "eu",
): DurableObjectNamespace {
	return jurisdiction === "eu" ? namespace.jurisdiction("eu") : namespace;
}
```

This is a design sketch, not a deployed helper. The implementation should use
the owning Cloudflare types without a generic if it loses the class stub type.
All name/id comparisons, persisted object pointers, alarms, facets, container
sessions and reverse mappings must migrate together. Shared global objects
need a tenant ownership decision before per-organization routing is possible.
DO migration requires a writer fence, logical-key inventory, authenticated
export/import, schema/checksum verification and an explicit cutover checkpoint.
Rollback after new writes requires reverse replay, not merely changing a flag.

## Required acceptance tests

Phase-1 tests live beside the residency contract, query, API admission and
transport owners. The remaining installation/migration cases below are design
requirements for later operator work. Use fictional organizations and endpoint
origins. No test may contact a live model or infrastructure account.

| Case                             | Required assertion                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| No row / unrestricted row        | Existing route, request body, budget and credential behavior remain unchanged; no extra provider request.    |
| EU with eligible member          | Only the enabled, unexpired, credentialed EU member reaches the transport.                                   |
| EU without credential            | Exact member credential reference returned; transport, billing reservation and fallback are not invoked.     |
| Empty EU pool                    | `EU_PROVIDER_POOL_REQUIRED`, no invented credential or non-EU send.                                          |
| Unknown/global region            | Explicit ref and retry rejected before network I/O.                                                          |
| Disabled/expired evidence        | Member excluded even if its hostname suggests an EU region.                                                  |
| Existing model/modality denial   | Residency selection cannot grant a previously denied model or modality.                                      |
| Cross-tenant secret/policy       | Organization A cannot read/update B or resolve B's credential.                                               |
| Malformed origin                 | Userinfo, redirects, lookalike domains and unexpected ports cannot bypass evidence pinning.                  |
| Adaptive route/fallback          | Every candidate constrained; non-EU receipt records a violation and prevents follow-up sends.                |
| Background/voice/image/embedding | Every modality and auxiliary path has a transport-level negative test.                                       |
| Policy read unavailable          | Restricted sends fail closed; no cached unrestricted fallback.                                               |
| Policy changes while queued      | Sender rejects stale revision and recomputes eligibility.                                                    |
| CAS and D1 facade                | Concurrent updates reject stale revision; no BEGIN or duplicate output-column name.                          |
| DO global versus EU              | Same logical name produces separate identities; lookup and self-check use selected namespace.                |
| Existing DO state                | An unmigrated object stays on its recorded jurisdiction despite a model policy change.                       |
| Cost neutrality                  | Disabled/missing policy does not invoke a model, reserve new capacity, enable overage or add a paid service. |
| Rollback after writes            | A stale source is never reactivated without verified reverse replay.                                         |

Before activation, add contract and DB facade tests plus owning Worker suites
using their scoped `AGENTS.md` commands. Cover the actual execution boundary,
not just a mocked selector. Prove absent-policy parity in local fixtures and
observe the exact approved live result separately from green tests and Ship.
