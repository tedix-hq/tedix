import { NAMESPACE_PEER_ALIASES } from "@tedix/mcp-shared/namespace-governance";
import {
	PLATFORM_OPERATOR_APP_SLUG,
	PLATFORM_OPERATOR_TOOL_DEFINITIONS,
} from "./platform-operator-tools";

export interface PlatformAggregateAppEntry {
	slug: string;
	/** Stable app id this entry links to; preferred over slug. */
	appId?: string;
	connectionLabel?: string;
	connectionProviderId?: string;
	connectionScope?: "tenant" | "user" | "hybrid";
	connectionScopes?: string[];
	forwardedQueryParams?: Record<string, string>;
	prefix?: string;
	readOnly?: boolean;
	organizationId?: string;
	endpointPrefixes?: string[];
	toolIds?: string[];
}

export const PLATFORM_OPERATOR_ADMIN_APP_SLUG = "tedix";

/**
 * Tedix OS is a tenant product surface, not a platform-admin capability. Every
 * tenant unified gateway must expose the same semantic Canvas verbs that its
 * browser instance uses. Derive the allowlist from the canonical definitions
 * so a newly-added OS verb cannot silently disappear from restricted tenant
 * aggregates.
 */
/**
 * Namespaces served by D1-synced platform-operator tools that are not present in
 * PLATFORM_OPERATOR_TOOL_DEFINITIONS. Discovery hydrates the full aggregate and
 * can see these, but targeted Code Mode hydration must also include the admin
 * app when code directly calls these namespaces.
 */
const D1_PLATFORM_OPERATOR_CODE_MODE_NAMESPACES = [
	"analytics",
	"audit",
	"cognitive",
	"control",
	"external",
	"kernel",
	"mcp",
	"organizations",
	"projects",
	"skills",
	"work",
] as const;

/**
 * Code Mode namespaces that the platform-operator admin app (`tedix`) resolves
 * to in the Code Mode surface.
 *
 * `resolveNamespace` in codemode.ts derives the namespace from the tool's
 * `config.endpoint` path prefix, applying `extractCamelCaseRoot` (leading
 * lowercase sequence of the camelCase segment). For example:
 *   - `tedis/list`              → `tedis`
 *   - `workflows/listRuns`      → `workflows`
 *   - `apps/list`               → `apps`
 *   - `appTools/list`           → `app`
 *   - `descopeAih/listMcpServers` → `descope`
 *   - `tediEmail/listAddressRequests` → `tedi`
 *
 * This set is used by `filterAggregateAppsForCodeNamespaces` so that a Code
 * Mode body calling e.g. `tedis.list_tedis(...)` or
 * `workflows.list_workflow_runs(...)` causes the `tedix` aggregate entry to be
 * included — even though the entry's slug is `tedix`, not `tedis`.
 *
 * Computed once from PLATFORM_OPERATOR_TOOL_DEFINITIONS so it stays in sync
 * with the actual tool surface without manual maintenance.
 */
export const PLATFORM_OPERATOR_CODE_MODE_NAMESPACES: ReadonlySet<string> =
	computePlatformOperatorCodeModeNamespaces();

function extractCamelCaseRoot(prefix: string): string {
	const match = prefix.match(/^[a-z]+/);
	return match ? match[0] : prefix.toLowerCase();
}

function computePlatformOperatorCodeModeNamespaces(): ReadonlySet<string> {
	const namespaces = new Set<string>();
	for (const def of PLATFORM_OPERATOR_TOOL_DEFINITIONS) {
		const endpointPrefix = def.endpoint.split("/")[0];
		if (endpointPrefix) {
			const ns = extractCamelCaseRoot(endpointPrefix);
			namespaces.add(ns);
			// SEAM C — also add the peer alias so both forms trigger the admin app.
			const aliasNs = NAMESPACE_PEER_ALIASES.get(ns);
			if (aliasNs !== undefined) {
				namespaces.add(aliasNs);
			}
		}
	}
	for (const namespace of D1_PLATFORM_OPERATOR_CODE_MODE_NAMESPACES) {
		namespaces.add(namespace);
	}
	return namespaces;
}

export function ensurePlatformOperatorAggregateApps<
	T extends PlatformAggregateAppEntry,
>(
	appSlug: string,
	entries: readonly T[],
): Array<T | PlatformAggregateAppEntry> {
	const adminAppIndex = entries.findIndex(
		(entry) => entry.slug === PLATFORM_OPERATOR_ADMIN_APP_SLUG,
	);
	if (adminAppIndex >= 0) return [...entries];
	if (appSlug !== PLATFORM_OPERATOR_APP_SLUG) {
		if (!appSlug.endsWith("-unified")) return [...entries];
		return [{ slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG }, ...entries];
	}

	return [{ slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG }, ...entries];
}
