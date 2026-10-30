# Provider configuration

Connection provider templates are stored in D1. The importer reads an explicit
installation-owned JSON manifest; the product does not choose a vendor list.
Keep managed provider selections and operational endpoints in private ops.

The manifest has `version: 1` and a `providers` array. Each item follows
`ConnectionProviderTemplateSchema` in
`packages/api-contract/src/schemas/connection-provider-templates.ts`.
Icons can use `{ASSETS_URL}`, expanded from the installation's `ASSETS_URL`.

Run `bun run connections:seed-providers --manifest /secure/providers.json` for
a dry run. Review its changes and copy its `snapshot` value, then repeat with
`--apply --expected-snapshot <snapshot>`. Use `--only provider-a,provider-b`
on both calls to select a subset. A stale snapshot or a concurrent row change
stops the import; inspect a fresh dry run before retrying. Rows absent from the
manifest are preserved, as are issuer pins and registration metadata.

Catalog maintenance uses the existing published system policy packs. Publish
an ownerless `system` pack with slug `catalog-maintenance`, target `shared`,
and a `definition.catalogPolicy` matching `CatalogMaintenancePolicySchema` in
`packages/api-contract/src/schemas/catalog-maintenance-policy.ts`. The policy
chooses the frequent-scan cohort and approved registry endpoints and R2
prefixes. The newest head must be active and have valid publication metadata;
an unpublished or revoked head cannot revive an older policy. Missing policy
disables only the frequent provider scan and refuses registry imports; ordinary
catalog scans and drift checks remain available. Publish installation policy
before deploying this configuration cutover.
