/**
 * Contract-surface version registry.
 *
 * The machine-readable declaration of which public surfaces carry a version,
 * what that version currently is, and which deprecation policy governs a
 * change to them. This is the single place a "public surface" becomes a
 * versioned commitment; everything absent from this file is internal and
 * aggressively refactorable: stable public contracts need versions and
 * deprecation windows even while internal implementation keeps changing.
 *
 * Enforcement: `apps/api/src/rpc/contract-surface-versions.test.ts` asserts
 * that `PUBLIC_REST_NAMESPACE_VERSIONS` covers exactly the `apiContract`
 * namespaces the public OpenAPI filter (`isPublicProcedure`) exposes. Adding a
 * `REST`-tagged procedure to a new namespace therefore fails closed until the
 * namespace is versioned here; deleting the last public procedure of a
 * namespace fails until its entry is removed (a recorded removal decision).
 *
 * Version semantics per policy:
 * - `stable-release-window`: MAJOR.MINOR.PATCH. Breaking change = announce
 *   (OpenAPI `deprecated` + changelog), dual-support for at least one stable
 *   release AND 90 days on the stable channel (LTS: for the LTS lifetime),
 *   then remove at the next MAJOR. Additive change bumps MINOR.
 * - `expand-contract`: the version is an append-only ordered ledger (the
 *   drizzle migration journal), not semver. Destructive schema change ships
 *   as expand -> migrate -> contract, with the contract step no earlier than
 *   the next stable release.
 * - `none`: unstable surface; may change on any nightly without a window.
 *   Pre-1.0 by definition.
 *
 * NO barrels — import via `@tedix/api-contract/contract-versions`.
 */

export type ContractSurfaceStability = "stable" | "unstable";

export type DeprecationPolicy =
	| "stable-release-window"
	| "expand-contract"
	| "none";

export interface ContractSurfaceVersion {
	/** Globally unique surface id, e.g. `rest:organizations`, `cli`. */
	readonly surface: string;
	/**
	 * Current declared version. `MAJOR.MINOR.PATCH` for
	 * `stable-release-window` surfaces; free-form for ledger-versioned or
	 * unstable surfaces (see the policy docs above).
	 */
	readonly version: string;
	readonly stability: ContractSurfaceStability;
	readonly deprecationPolicy: DeprecationPolicy;
}

/**
 * Public REST namespaces (`/v1/*`), keyed by their `apiContract` namespace.
 *
 * A namespace appears here exactly when at least one of its procedures is
 * admitted by `isPublicProcedure` (tagged `REST`, not `internal`). The
 * per-operation inventory stays in
 * `apps/api/src/rpc/public-rest-operations.ts`; this registry owns the
 * version and policy of the namespace as a surface. All start at 1.0.0: the
 * `/v1` prefix and the OpenAPI document already declare version 1.0.0, and
 * every operation in the current inventory went through the public-REST
 * review.
 */
export const PUBLIC_REST_NAMESPACE_VERSIONS = {
	appAdapters: {
		surface: "rest:appAdapters",
		version: "1.0.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
	appTools: {
		surface: "rest:appTools",
		version: "1.0.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
	apps: {
		surface: "rest:apps",
		version: "1.0.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
	audit: {
		surface: "rest:audit",
		version: "1.0.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
	billing: {
		surface: "rest:billing",
		version: "1.0.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
	catalog: {
		surface: "rest:catalog",
		version: "1.0.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
	members: {
		surface: "rest:members",
		version: "1.0.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
	orgUsage: {
		surface: "rest:orgUsage",
		version: "1.0.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
	organizations: {
		surface: "rest:organizations",
		version: "1.0.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
	/**
	 * 1.1.0 — additive: `POST /tedi-app-assignments` and
	 * `PATCH /tedi-app-assignments/{assignmentId}` responses gained a required
	 * `aihClientSync` object reporting the Descope AIH client sync outcome, and
	 * the managed reconcile result gained `aihClientSyncs`. No request shape,
	 * route, or existing response field changed, so per this file's
	 * `stable-release-window` semantics ("Additive change bumps MINOR") this is
	 * a MINOR bump with no deprecation window owed.
	 */
	tediAppAssignments: {
		surface: "rest:tediAppAssignments",
		version: "1.1.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
	tediUsage: {
		surface: "rest:tediUsage",
		version: "1.0.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
	tedis: {
		surface: "rest:tedis",
		version: "1.0.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
	templates: {
		surface: "rest:templates",
		version: "1.0.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
	tenantCatalog: {
		surface: "rest:tenantCatalog",
		version: "1.0.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
} as const satisfies Record<string, ContractSurfaceVersion>;

/**
 * Non-REST public surfaces.
 *
 * These entries record the decision, not (yet) machine parity — each one's
 * enforcement hook is listed beside it. Keep versions here in sync with their
 * owning artifact; where a cross-package test cannot exist without inventing
 * a dependency edge, the sync rule is stated in the entry comment and in
 * `DESIGN.md`.
 */
export const PLATFORM_SURFACE_VERSIONS = {
	/**
	 * The generated public OpenAPI document (`/openapi.json`). Must equal
	 * `OPENAPI_SPEC_BASE.info.version`; asserted by
	 * `contract-surface-versions.test.ts`.
	 */
	"openapi-document": {
		surface: "openapi-document",
		version: "1.0.0",
		stability: "stable",
		deprecationPolicy: "stable-release-window",
	},
	/**
	 * `tedix` CLI command surface (verbs, flags, machine-readable output).
	 * Pre-1.0 (`packages/cli` is 0.1.0 and unpublished); no window until the
	 * first stable release channel ships.
	 */
	cli: {
		surface: "cli",
		version: "0.1.0",
		stability: "unstable",
		deprecationPolicy: "none",
	},
	/**
	 * `@tedix/installation-manifest` document format. The concrete version is
	 * the `schemaVersion: z.literal("1.0")` in
	 * `packages/installation-manifest/src/schema.ts`; strict objects mean any
	 * field addition is a version event (see DESIGN.md evolution rules).
	 * Unstable until the first certified clean-account install ships.
	 */
	"installation-manifest": {
		surface: "installation-manifest",
		version: "1.0",
		stability: "unstable",
		deprecationPolicy: "none",
	},
	/**
	 * Shared-D1 schema lineage. The version is the append-only drizzle
	 * journal in `packages/db/drizzle` (head tag, not semver); enforced by
	 * `db:migrate:history-check` / `db:migrate:chain-check` and the guarded
	 * `db:push`.
	 */
	"db-migrations": {
		surface: "db-migrations",
		version: "drizzle-journal",
		stability: "stable",
		deprecationPolicy: "expand-contract",
	},
	/**
	 * Tenant export/import format. Today only app snapshots exist, with a
	 * free-text `versionTag` and no format version — deliberately declared
	 * unversioned until a stable export/import format is defined.
	 */
	"export-import": {
		surface: "export-import",
		version: "0.0.0",
		stability: "unstable",
		deprecationPolicy: "none",
	},
} as const satisfies Record<string, ContractSurfaceVersion>;
