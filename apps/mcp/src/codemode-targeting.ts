import { AggregateAppEntry } from "./aggregate-types";
import {
	aggregateAppNamespaceCandidates,
	aggregateTediNamespace,
	isOrganizationMountNamespace,
} from "./mcp/aggregate-namespaces";
import type { AggregateTediEntry } from "./mcp/aggregate-tedis";
import {
	PLATFORM_OPERATOR_ADMIN_APP_SLUG,
	PLATFORM_OPERATOR_CODE_MODE_NAMESPACES,
} from "./mcp/platform-operator-aggregation";

/**
 * Aggregate namespaces a direct (non-`code`) tools/call needs, or null for the
 * full catalog. A root-app API (rpc) tool needs none; the native catalog
 * search/describe tools need only the namespace they name; a prefixed aggregate
 * tool (`ns__tool`) needs its own namespace. An unknown unprefixed name cannot
 * identify an aggregate tool, so it needs no aggregate catalog.
 */
export function directToolCallNamespaces(
	toolName: string | undefined,
	args: Record<string, unknown>,
	rootTools: ReadonlyArray<{
		toolId: string;
		config?: Record<string, unknown> | null;
	}>,
): Set<string> | null {
	if (!toolName || toolName === "code" || toolName === "get_info") return null;
	const root = rootTools.find((tool) => tool.toolId === toolName);
	if (root) {
		const transport = root.config?.transport ?? "rpc";
		// An API call needs no catalog; other transports may read loaded tools.
		if (transport === "rpc") return new Set();
		if (transport !== "catalog") return null;
		if (root.config?.endpoint === "catalog/search")
			return typeof args.namespace === "string" && args.namespace
				? new Set([args.namespace])
				: null;
		const callable = typeof args.callable === "string" ? args.callable : "";
		const dot = callable.indexOf(".");
		return dot > 0 ? new Set([callable.slice(0, dot)]) : null;
	}
	// Aggregated tools keep the raw entry prefix (`acme-catalog__search`),
	// while namespace matching compares the sanitized Code Mode namespace.
	const separator = toolName.indexOf("__");
	return separator > 0
		? new Set([toolName.slice(0, separator).replace(/[^a-zA-Z0-9_]/g, "_")])
		: new Set();
}

export function filterAggregateAppsForCodeNamespaces(
	entries: AggregateAppEntry[],
	namespaces: Set<string> | null,
	namespaceOverrides?: Record<string, string>,
): AggregateAppEntry[] {
	if (!namespaces) return entries;
	if (namespaces.size === 0) return [];
	const matchedNamespaces = new Set<string>();
	const filtered = entries.filter((entry) => {
		const candidates = aggregateAppNamespaceCandidates(
			entry,
			namespaceOverrides,
		);
		let matched = false;
		for (const candidate of candidates) {
			if (namespaces.has(candidate)) {
				matchedNamespaces.add(candidate);
				matched = true;
			}
		}
		if (entry.organizationMount) {
			for (const ns of namespaces) {
				if (isOrganizationMountNamespace(entry.prefix ?? entry.slug, ns)) {
					matchedNamespaces.add(ns);
					matched = true;
				}
			}
		}
		if (matched) return true;
		// The platform-operator admin app (slug "tedix") stores tools whose Code
		// Mode namespaces are derived from endpoint path prefixes (e.g.
		// "tedis/list" → namespace "tedis", "workflows/listRuns" → "workflows").
		// These do not match the entry slug "tedix", so the standard candidate
		// check above misses them. When a directly-called namespace matches any
		// platform-operator Code Mode namespace, include the "tedix" entry so
		// those tools are hydrated on demand — same lazy, bounded behavior as
		// aggregate app hydration.
		if (candidates.has(PLATFORM_OPERATOR_ADMIN_APP_SLUG)) {
			const platformMatches = [...namespaces].filter((ns) =>
				PLATFORM_OPERATOR_CODE_MODE_NAMESPACES.has(ns),
			);
			for (const ns of platformMatches) matchedNamespaces.add(ns);
			return platformMatches.length > 0;
		}
		return false;
	});
	// Fail-open for unmatched namespaces: PLATFORM_OPERATOR_CODE_MODE_NAMESPACES
	// only covers the statically-defined tool endpoints, but the admin app also
	// serves a long tail of D1-synced namespaces (skills, memory, rationale,
	// kernel, submissions, …) that discovery can see. A snippet calling
	// `skills.list_skills_by_org(...)` directly (no `discover.` reference) used
	// would filter the admin entry out, so the namespace was never mounted and
	// the sandbox threw a misleading "skills is not defined". When any
	// requested namespace matched nothing, include the
	// platform-operator admin entry so its D1 tail is hydrated. Local variables
	// in the snippet can land here too (`results.map(...)`) — that only costs
	// one extra entry hydration, never correctness.
	const hasUnmatched = [...namespaces].some((ns) => !matchedNamespaces.has(ns));
	if (hasUnmatched) {
		const adminEntry = entries.find((entry) =>
			aggregateAppNamespaceCandidates(entry, namespaceOverrides).has(
				PLATFORM_OPERATOR_ADMIN_APP_SLUG,
			),
		);
		if (adminEntry && !filtered.includes(adminEntry)) {
			filtered.push(adminEntry);
		}
	}
	return filtered;
}

export function filterAggregateTedisForCodeNamespaces(
	entries: AggregateTediEntry[] | undefined,
	namespaces: Set<string> | null,
): AggregateTediEntry[] | undefined {
	if (!entries || !namespaces) return entries;
	if (namespaces.size === 0) return [];
	// flow.* resolves its owner from mounted workflow capabilities. Hydrate the
	// small configured workforce so tenant gateways without a `cto` namespace can
	// select their sole operator; ambiguous gateways require an explicit tediSlug.
	if (namespaces.has("flow")) return entries;
	return entries.filter((entry) =>
		namespaces.has(aggregateTediNamespace(entry)),
	);
}
