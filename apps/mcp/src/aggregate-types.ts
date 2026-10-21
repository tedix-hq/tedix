export type InternalAppTool = import("./mcp/server-context").AppTool;
type InternalCatalogMcpResource =
	import("./mcp/server-context").CatalogMcpResource;
type InternalCatalogMcpResourceTemplate =
	import("./mcp/server-context").CatalogMcpResourceTemplate;
type InternalCatalogMcpPrompt = import("./mcp/server-context").CatalogMcpPrompt;

export type AggregateAppEntry = {
	slug: string;
	/**
	 * Stable app id this entry links to; preferred over slug. Slug remains for
	 * display and as a fallback for entries written before ids were stored.
	 */
	appId?: string;
	/**
	 * Organization of the app whose `aggregateApps` holds this entry. Never read
	 * from stored metadata: the gateway stamps it from the resolved host app so
	 * apps/api can apply the aggregate ownership rule to an id-linked entry.
	 */
	hostOrganizationId?: string;
	connectionInstanceId?: string;
	/** Present only on a server-verified multi-organization selection. */
	organizationId?: string;
	/** The selected organization's own gateway, mounted by a Connect selection. */
	organizationMount?: boolean;
	/** Flat namespace these tools answered to before per-app namespaces. */
	legacyNamespace?: string;
	connectionLabel?: string;
	connectionProviderId?: string;
	connectionScope?: "tenant" | "user" | "hybrid";
	connectionScopes?: string[];
	prefix?: string;
	endpointPrefixes?: string[];
	toolIds?: string[];
	/**
	 * Mount only the source's read tools.
	 *
	 * A rule rather than a list: an enumerated `toolIds` snapshot has to be
	 * recomputed whenever the source changes, and a snapshot that nobody
	 * refreshes silently withholds every tool added after it was taken.
	 */
	readOnly?: boolean;
	forwardedQueryParams?: Record<string, string>;
};

export interface InternalResolveResult {
	tools: InternalAppTool[];
	connectionInstanceId?: string;
	appId: string | null;
	/** The resolved app's current slug (an id-linked entry may store an old one). */
	appSlug?: string | null;
	/** The resolved app's organization; hosts the nested `aggregateApps` entries. */
	organizationId?: string | null;
	upstreamMcpUrl: string | null;
	connectionLabel: string | null;
	connectionProviderId: string | null;
	connectionScope: "tenant" | "user" | "hybrid" | null;
	connectionScopes: string[] | null;
	catalogResources: InternalCatalogMcpResource[];
	catalogResourceTemplates: InternalCatalogMcpResourceTemplate[];
	catalogPrompts: InternalCatalogMcpPrompt[];
	/** Query params to append when a forked upstream tool row calls its upstream. */
	forwardedQueryParams: Record<string, string> | null;
	/** Nested aggregate refs from `mcpConfig.aggregateApps`. Used by aggregateAndPrefixTools
	 *  to recurse through D1-backed app bundles. */
	aggregateApps: Array<{
		slug: string;
		appId?: string;
		connectionInstanceId?: string;
		endpointPrefixes?: string[];
		toolIds?: string[];
		readOnly?: boolean;
		connectionLabel?: string;
		connectionProviderId?: string;
		connectionScope?: "tenant" | "user" | "hybrid";
		connectionScopes?: string[];
		prefix?: string;
		forwardedQueryParams?: Record<string, string>;
	}> | null;
	resolutionFailed?: boolean;
	/** The app's own `mcpConfig.toolScopes`, unvalidated. */
	toolScopes?: unknown;
}

export interface AggregatedMcpSurface {
	tools: InternalAppTool[];
	resources: InternalCatalogMcpResource[];
	resourceTemplates: InternalCatalogMcpResourceTemplate[];
	prompts: InternalCatalogMcpPrompt[];
	degraded?: boolean;
	/** Connect organization-mount scopes, keyed by the namespaces Connect serves. */
	toolScopes?: Record<string, string[]>;
}
