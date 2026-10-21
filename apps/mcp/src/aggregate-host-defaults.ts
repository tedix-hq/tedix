import type { AggregateAppEntry } from "./aggregate-types";

/**
 * Add Connect organization-mount scopes to a request's app metadata. Connect's
 * own keys win; the mount keys only name namespaces Connect serves for the
 * selected organizations, so they never widen an existing Connect rule.
 */
export function withMountToolScopes<T extends { mcpConfig?: unknown } | null>(
	metadata: T,
	mountToolScopes: Record<string, string[]>,
): T {
	const mcpConfig =
		metadata?.mcpConfig && typeof metadata.mcpConfig === "object"
			? (metadata.mcpConfig as Record<string, unknown>)
			: {};
	const own =
		mcpConfig.toolScopes && typeof mcpConfig.toolScopes === "object"
			? (mcpConfig.toolScopes as Record<string, string[]>)
			: {};
	return {
		...metadata,
		mcpConfig: { ...mcpConfig, toolScopes: { ...mountToolScopes, ...own } },
	} as T;
}
export function withAggregateConnectionProvider(
	config: Record<string, unknown>,
	provider: {
		connectionProviderId?: string;
		connectionScope?: "tenant" | "user" | "hybrid";
		connectionScopes?: string[];
	},
): Record<string, unknown> {
	if (!provider.connectionProviderId) return config;

	const existingAuth =
		typeof config.auth === "object" && config.auth !== null
			? ({ ...(config.auth as Record<string, unknown>) } as Record<
					string,
					unknown
				>)
			: null;

	if (existingAuth?.type && existingAuth.type !== "connection") return config;
	const auth = existingAuth ?? { type: "connection" };

	auth.connectionId = provider.connectionProviderId;
	if (provider.connectionScope) {
		auth.credentialScope = provider.connectionScope;
		auth.scope = provider.connectionScope;
	}
	if (provider.connectionScopes?.length) {
		auth.scopes = provider.connectionScopes;
	}

	return {
		...config,
		auth,
		_aggregateConnectionProviderId: provider.connectionProviderId,
	};
}

/**
 * Stamp the host app's organization onto its own `aggregateApps` entries.
 *
 * apps/api resolves an id-linked entry only when the target belongs to this
 * organization or to the platform organization, so the host is always taken
 * from the resolved app — never from a value stored in the entry itself. An
 * id-linked entry of a host with no known organization resolves to nothing.
 */
export function withAggregateHostOrganization(
	entries: AggregateAppEntry[],
	hostOrganizationId: string | null | undefined,
): AggregateAppEntry[] {
	return entries.map((entry) => {
		const { hostOrganizationId: _stored, ...rest } = entry;
		return hostOrganizationId ? { ...rest, hostOrganizationId } : rest;
	});
}

/**
 * Default aggregate entries' connection overrides from the host app's own
 * mcpConfig before resolution. Without it the base app's connection settings
 * win and a thin multi-tenant aggregator serves the base credential; see
 * `docs/engineering/mcp/runtime.md`.
 *
 * Per-field precedence after this step: explicit entry value > host app
 * mcpConfig > aggregated app mcpConfig (the last fallback lives in
 * aggregateAndPrefixToolsUncached's `entry.X ?? appX` resolution).
 *
 * Defaults apply only when the host declares its own `connectionProviderId` —
 * the override is meaningful as a bundle keyed on the provider id. A
 * host-level `connectionScope` or `connectionLabel` without one must not be
 * injected here (it qualifies the host's own direct tools, and the label
 * already reaches aggregated tools via `ctx.connectionLabel`).
 *
 * Applied at entry-build time, not inside the aggregate resolver: that keeps
 * nested aggregation correct and makes `aggregateSurfaceCacheKey` distinguish
 * hosts that aggregate the same base app with different credentials.
 */
export function applyHostConnectionDefaultsToAggregateEntries(
	entries: AggregateAppEntry[],
	hostMcpConfig:
		| {
				connectionLabel?: unknown;
				connectionInstanceId?: unknown;
				connectionProviderId?: unknown;
				connectionScope?: unknown;
				connectionScopes?: unknown;
		  }
		| null
		| undefined,
): AggregateAppEntry[] {
	const hostConnectionProviderId =
		typeof hostMcpConfig?.connectionProviderId === "string" &&
		hostMcpConfig.connectionProviderId
			? hostMcpConfig.connectionProviderId
			: null;
	if (!hostConnectionProviderId) return entries;

	const hostConnectionLabel =
		typeof hostMcpConfig?.connectionLabel === "string" &&
		hostMcpConfig.connectionLabel
			? hostMcpConfig.connectionLabel
			: undefined;
	const hostConnectionScope =
		hostMcpConfig?.connectionScope === "tenant" ||
		hostMcpConfig?.connectionScope === "user" ||
		hostMcpConfig?.connectionScope === "hybrid"
			? hostMcpConfig.connectionScope
			: undefined;
	const filteredHostConnectionScopes = Array.isArray(
		hostMcpConfig?.connectionScopes,
	)
		? hostMcpConfig.connectionScopes.filter(
				(scope): scope is string => typeof scope === "string",
			)
		: undefined;
	const hostConnectionScopes = filteredHostConnectionScopes?.length
		? filteredHostConnectionScopes
		: undefined;

	return entries.map((entry) => {
		if (
			hostMcpConfig?.connectionInstanceId &&
			entry.connectionProviderId &&
			entry.connectionProviderId !== hostConnectionProviderId
		)
			return entry;
		return {
			...entry,
			connectionProviderId:
				entry.connectionProviderId ?? hostConnectionProviderId,
			connectionLabel: entry.connectionLabel ?? hostConnectionLabel,
			connectionInstanceId:
				entry.connectionInstanceId ??
				(typeof hostMcpConfig?.connectionInstanceId === "string"
					? hostMcpConfig.connectionInstanceId
					: undefined),
			connectionScope: entry.connectionInstanceId
				? (entry.connectionScope ?? hostConnectionScope)
				: typeof hostMcpConfig?.connectionInstanceId === "string"
					? hostConnectionScope
					: (entry.connectionScope ?? hostConnectionScope),
			connectionScopes: entry.connectionScopes ?? hostConnectionScopes,
		};
	});
}
